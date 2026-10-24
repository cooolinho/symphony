#!/usr/bin/env bash
# Deterministic quality gate for a Laravel app in the current workspace.
# Exit codes: 0 pass, 1 the code must be fixed (output goes to the agent),
# 2 an environment problem, 78 (only with --full) no Laravel app, so the check does not apply.
# The app directory is $SYMPHONY_LARAVEL_APP_PATH; without it, the current directory,
# or the single first-level subdirectory that holds an app (like Symphony's detection).
#
#   laravel.sh          fast gate: Pint on the changed files, static analysis, tests
#   laravel.sh --full   the project's CI: Pint on every file, static analysis, migrations and tests; with
#                       SYMPHONY_CI_DB=mysql against a MySQL database of its own (SYMPHONY_MYSQL_*), dropped afterwards;
#                       with SYMPHONY_CI_PARALLEL=<n> in n processes (php artisan test --parallel, needs paratest)
set -u
# shellcheck source=checks/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

full=false
[ "${1:-}" = --full ] && full=true

# The failed tests of PHPUnit/Pest output, one per line with the first line of its message: PHPUnit's "1) Class::method"
# (also in parallel runs) and Collision's "FAILED  Class > method". The tail of the output is mostly stack traces.
failed_tests() {
  sed -E 's/\x1b\[[0-9;]*[A-Za-z]//g' | awk '
    /^[0-9]+\) [A-Za-z_\\]/ { name = $0; want = 1; next }
    want && NF { sub(/^[ \t]+/, ""); print name " — " substr($0, 1, 200); want = 0; next }
    /^ *(FAILED|ERROR) +[A-Za-z_\\]/ { sub(/^ +/, ""); print substr($0, 1, 300) }
  ' | head -n 30
}

# Runs a command, shows only the tail of its output when it fails; for tests, the list of failed tests comes last, so
# it survives when the guard shortens the output from the front.
run() {
  local label=$1 out status failed
  shift
  out=$("$@" 2>&1)
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "$label failed (exit $status):"
    printf '%s\n' "$out" | tail -c 4000
    failed=$(printf '%s\n' "$out" | failed_tests)
    if [ -n "$failed" ]; then
      printf '\nFailed tests:\n%s\n' "$failed"
    fi
    exit 1
  fi
}

cd "${SYMPHONY_LARAVEL_APP_PATH:-.}" 2>/dev/null || env_problem "cannot enter ${SYMPHONY_LARAVEL_APP_PATH}"

if [ -z "${SYMPHONY_LARAVEL_APP_PATH:-}" ] && [ ! -f artisan ]; then
  apps=()
  for dir in */; do
    case "$dir" in vendor/ | node_modules/) continue ;; esac
    [ -f "${dir}artisan" ] && [ -f "${dir}composer.json" ] && apps+=("${dir%/}")
  done
  if [ "${#apps[@]}" -eq 1 ]; then
    cd "${apps[0]}" || env_problem "cannot enter ${apps[0]}"
  elif [ "${#apps[@]}" -gt 1 ]; then
    env_problem "several Laravel apps (${apps[*]}); set SYMPHONY_LARAVEL_APP_PATH to the one to check"
  fi
fi

if [ ! -f artisan ]; then
  $full && skip "no Laravel app; nothing to check"
  echo "no Laravel app; nothing to check"
  exit 0
fi

command -v php >/dev/null 2>&1 || env_problem "php not found"
[ -f vendor/autoload.php ] || env_problem "vendor/ is missing or broken (run composer install)"

# 2. Clean tree, 3. everything pushed
require_clean_and_pushed

# 4. PHP syntax of changed files
base=$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null) || {
  git remote set-head origin -a >/dev/null 2>&1
  base=$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null) || env_problem "cannot determine the default branch (origin/HEAD)"
}
changed=()
while IFS= read -r file; do
  [ -n "$file" ] && changed+=("$file")
done < <(git diff --relative --name-only --diff-filter=ACMR "$base"...HEAD -- '*.php' 2>/dev/null)

syntax_errors=""
for file in ${changed[@]+"${changed[@]}"}; do
  out=$(php -l "$file" 2>&1) || syntax_errors+="$out"$'\n'
done
if [ -n "$syntax_errors" ]; then
  echo "PHP syntax errors:"
  printf '%s' "$syntax_errors" | head -n 30
  exit 1
fi

# Composer scripts are read from `composer run-script --list`: one "  name  description" line per script
# defined in composer.json on stdout (the "scripts:" heading goes to stderr). Composer has no --raw here.
scripts=""
if [ -f composer.json ] && command -v composer >/dev/null 2>&1; then
  listing=$(composer run-script --list --no-ansi 2>/dev/null) || env_problem "composer run-script --list failed"
  scripts=$(printf '%s\n' "$listing" | awk 'NF {print $1}')
fi
has_script() { printf '%s\n' "$scripts" | grep -qx "$1"; }

# 5. Style (--full: every file, like CI)
if has_script lint; then
  run "composer lint" composer run-script lint
elif [ -x vendor/bin/pint ] && $full; then
  run "pint" vendor/bin/pint --test
elif [ -x vendor/bin/pint ] && [ ${#changed[@]} -gt 0 ]; then
  run "pint" vendor/bin/pint --test "${changed[@]}"
fi

# 6. Static analysis
if has_script analyse; then
  run "composer analyse" composer run-script analyse
elif [ -f phpstan.neon ] || [ -f phpstan.neon.dist ]; then
  [ -x vendor/bin/phpstan ] || env_problem "phpstan is configured but vendor/bin/phpstan is missing"
  run "phpstan" vendor/bin/phpstan analyse --no-progress
fi

# 7a. --full with SYMPHONY_CI_DB=mysql: the tests run against a MySQL database of their own, migrated first like in CI.
# The process environment beats both .env and the <env> entries of phpunit.xml (without force="true").
if $full && [ "${SYMPHONY_CI_DB:-}" = mysql ]; then
  command -v mysql >/dev/null 2>&1 || env_problem "SYMPHONY_CI_DB=mysql needs the mysql client"
  [ -n "${SYMPHONY_MYSQL_USER:-}" ] || env_problem "SYMPHONY_CI_DB=mysql needs SYMPHONY_MYSQL_USER"
  ci_db="symphony_$(printf '%s' "${SYMPHONY_WORKSPACE_KEY:-$PWD}" | sha256sum | cut -c1-12)_ci"
  mysql_run() {
    MYSQL_PWD="${SYMPHONY_MYSQL_PASSWORD:-}" mysql --host="${SYMPHONY_MYSQL_HOST:-127.0.0.1}" --port="${SYMPHONY_MYSQL_PORT:-3306}" \
      --user="$SYMPHONY_MYSQL_USER" --execute="$1" 2>&1
  }
  out=$(mysql_run "DROP DATABASE IF EXISTS \`$ci_db\`; CREATE DATABASE \`$ci_db\`") ||
    env_problem "cannot create the MySQL database $ci_db on ${SYMPHONY_MYSQL_HOST:-127.0.0.1}: $out"
  # Drops the database and those of parallel test processes (<database>_test_<n>): --drop-databases skips them when
  # tests fail.
  drop_ci_databases() {
    local db
    for db in "$ci_db" $(mysql_run "SHOW DATABASES LIKE '${ci_db//_/\\_}\\_test\\_%'" | tail -n +2); do
      mysql_run "DROP DATABASE IF EXISTS \`$db\`" >/dev/null || true
    done
  }
  trap drop_ci_databases EXIT
  export DB_CONNECTION=mysql DB_HOST="${SYMPHONY_MYSQL_HOST:-127.0.0.1}" DB_PORT="${SYMPHONY_MYSQL_PORT:-3306}" \
    DB_DATABASE="$ci_db" DB_USERNAME="$SYMPHONY_MYSQL_USER" DB_PASSWORD="${SYMPHONY_MYSQL_PASSWORD:-}" DB_URL=
  echo "tests against MySQL database $ci_db"
  run "php artisan config:clear" php artisan config:clear
  run "php artisan migrate" php artisan migrate --force --no-interaction
fi

# 7b. --full with SYMPHONY_CI_PARALLEL=<n>: the tests in n processes. A paratest the project requires but the workspace
# lacks (vendor/ installed before it was added) is installed first when composer.lock is not tracked, so the tree stays
# clean. With MySQL every process gets a database of its own (<database>_test_<n>), dropped afterwards.
parallel=()
if $full && [ -n "${SYMPHONY_CI_PARALLEL:-}" ]; then
  case "$SYMPHONY_CI_PARALLEL" in '' | *[!0-9]* | 0) env_problem "SYMPHONY_CI_PARALLEL must be a number of processes (got '$SYMPHONY_CI_PARALLEL')" ;; esac
  if [ ! -x vendor/bin/paratest ] && grep -q '"brianium/paratest"' composer.json 2>/dev/null && ! git ls-files --error-unmatch composer.lock >/dev/null 2>&1; then
    run "composer update brianium/paratest" composer update brianium/paratest --no-interaction --no-progress --no-scripts
  fi
  if [ -x vendor/bin/paratest ]; then
    parallel=(--parallel --processes="$SYMPHONY_CI_PARALLEL" --drop-databases)
    echo "tests in $SYMPHONY_CI_PARALLEL parallel processes"
  else
    echo "SYMPHONY_CI_PARALLEL is set, but the project has no brianium/paratest: the tests run in one process"
  fi
fi

# 7. Tests
if has_script test; then
  run "composer test" composer run-script test
else
  run "php artisan test" php artisan test ${parallel[@]+"${parallel[@]}"}
fi

echo "all checks passed"
exit 0
