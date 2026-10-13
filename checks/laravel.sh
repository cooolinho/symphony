#!/usr/bin/env bash
# Deterministic quality gate for a Laravel app in the current workspace.
# Exit codes: 0 pass, 1 the code must be fixed (output goes to the agent),
# anything else (here: 2) an environment problem.
# The app directory is $SYMPHONY_LARAVEL_APP_PATH; without it, the current directory,
# or the single first-level subdirectory that holds an app (like Symphony's detection).
set -u

fix() { echo "$*"; exit 1; }
env_problem() { echo "environment: $*"; exit 2; }

# Runs a command, shows only the tail of its output when it fails.
run() {
  local label=$1 out status
  shift
  out=$("$@" 2>&1)
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "$label failed (exit $status):"
    printf '%s\n' "$out" | tail -c 4000
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
  echo "no Laravel app; nothing to check"
  exit 0
fi

command -v git >/dev/null 2>&1 || env_problem "git not found"
command -v php >/dev/null 2>&1 || env_problem "php not found"
[ -f vendor/autoload.php ] || env_problem "vendor/ is missing or broken (run composer install)"

# 2. Clean tree
status=$(git status --porcelain 2>&1) || env_problem "git status failed: $status"
if [ -n "$status" ]; then
  echo "working tree is not clean; commit or remove these changes:"
  printf '%s\n' "$status" | head -n 50
  exit 1
fi

# 3. Everything pushed
git fetch -q origin 2>/dev/null || env_problem "git fetch origin failed"
if ! git rev-parse -q --verify '@{u}' >/dev/null 2>&1; then
  fix "branch has no upstream; push the branch (git push -u origin HEAD)"
fi
unpushed=$(git log --oneline '@{u}..HEAD' 2>&1) || env_problem "git log failed: $unpushed"
if [ -n "$unpushed" ]; then
  echo "unpushed commits; push the branch:"
  printf '%s\n' "$unpushed" | head -n 20
  exit 1
fi

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

# Composer scripts are read from `composer run-script --list --raw`
# (one "name  description" line per script defined in composer.json).
scripts=""
if [ -f composer.json ] && command -v composer >/dev/null 2>&1; then
  scripts=$(composer run-script --list --raw 2>/dev/null | awk '{print $1}') \
    || env_problem "composer run-script --list failed"
fi
has_script() { printf '%s\n' "$scripts" | grep -qx "$1"; }

# 5. Style
if has_script lint; then
  run "composer lint" composer run-script lint
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

# 7. Tests
if has_script test; then
  run "composer test" composer run-script test
else
  run "php artisan test" php artisan test
fi

echo "all checks passed"
exit 0
