#!/usr/bin/env bash
# Gives every Laravel app in the workspace its own .env and SQLite database.
# With SYMPHONY_LARAVEL_DB=mysql it uses two MySQL databases per workspace instead (see docs/configuration.md).
# Run from hooks.after_create after the clone. Silent no-op when there is no app to prepare.
set -euo pipefail

workspace="$(cd "${SYMPHONY_WORKSPACE:-$(pwd)}" && pwd -P)"
use_mysql=false
[ "${SYMPHONY_LARAVEL_DB:-}" = mysql ] && use_mysql=true

# Rewrites $1 in place: each key in $SETTINGS ("KEY=value" lines) replaces its first (possibly commented)
# definition, later definitions are dropped, missing keys are appended. DB_HOST & co. are commented out.
rewrite_env() {
  local file="$1" tmp
  tmp="$(mktemp "$file.XXXXXX")"
  awk '
    BEGIN {
      n = split(ENVIRON["SETTINGS"], lines, "\n")
      for (i = 1; i <= n; i++) {
        eq = index(lines[i], "=")
        if (eq == 0) continue
        key = substr(lines[i], 1, eq - 1)
        order[++count] = key
        value[key] = substr(lines[i], eq + 1)
      }
      split("DB_HOST DB_PORT DB_USERNAME DB_PASSWORD", off, " ")
      for (i in off) disabled[off[i]] = 1
    }
    {
      line = $0
      probe = line
      sub(/^[ \t]*#?[ \t]*(export[ \t]+)?/, "", probe)
      if (match(probe, /^[A-Za-z_][A-Za-z0-9_]*[ \t]*=/)) {
        key = substr(probe, 1, RLENGTH - 1)
        sub(/[ \t]+$/, "", key)
        commented = (line ~ /^[ \t]*#/)
        if (key in value) {
          if (!(key in seen)) { seen[key] = 1; print key "=" value[key] }
          next
        }
        if (key in disabled && !commented) { print "# " line; next }
      }
      print line
    }
    END {
      for (i = 1; i <= count; i++) if (!(order[i] in seen)) print order[i] "=" value[order[i]]
    }
  ' "$file" > "$tmp"
  cat "$tmp" > "$file"
  rm -f "$tmp"
}

# Adds $2 (an absolute path inside the app's checkout) to .git/info/exclude unless git already ignores it.
exclude_untracked() {
  local app="$1" target="$2" prefix exclude
  git -C "$app" rev-parse --git-dir >/dev/null 2>&1 || return 0
  git -C "$app" check-ignore -q "$target" 2>/dev/null && return 0
  prefix="$(git -C "$app" rev-parse --show-prefix)"
  exclude="$(git -C "$app" rev-parse --path-format=absolute --git-path info/exclude)"
  mkdir -p "$(dirname "$exclude")"
  printf '/%s%s\n' "$prefix" "${target#"$app"/}" >> "$exclude"
}

# Name of the workspace's development database; "<name>_test" is the test database. 12 hex characters keep it < 64.
mysql_name() {
  printf 'symphony_%s' "$(printf '%s' "${SYMPHONY_WORKSPACE_KEY:?SYMPHONY_WORKSPACE_KEY is required for MySQL}" | sha256sum | cut -c1-12)"
}

# Quotes $1 as a .env value unless it only holds plain characters.
env_quote() {
  local v="$1"
  case "$v" in
    '' | *[!A-Za-z0-9_.,:/@%+=-]*) v="${v//\\/\\\\}"; v="${v//\"/\\\"}"; printf '"%s"' "${v//\$/\\\$}" ;;
    *) printf '%s' "$v" ;;
  esac
}

# Creates the databases given as arguments. The password only travels in MYSQL_PWD, never in arguments or output.
create_mysql_databases() {
  local name
  for name in "$@"; do
    if ! MYSQL_PWD="${SYMPHONY_MYSQL_PASSWORD:-}" mysql --host="$mysql_host" --port="$mysql_port" \
      --user="$SYMPHONY_MYSQL_USER" --execute="CREATE DATABASE IF NOT EXISTS \`$name\`"; then
      echo "laravel-env: CREATE DATABASE $name failed on $mysql_host:$mysql_port as $SYMPHONY_MYSQL_USER" >&2
      exit 1
    fi
  done
}

if $use_mysql; then
  : "${SYMPHONY_MYSQL_USER:?laravel-env: SYMPHONY_LARAVEL_DB=mysql needs SYMPHONY_MYSQL_USER}"
  case "${SYMPHONY_MYSQL_PASSWORD:-}" in *$'\n'*) echo "laravel-env: SYMPHONY_MYSQL_PASSWORD must be a single line" >&2; exit 1 ;; esac
  mysql_host="${SYMPHONY_MYSQL_HOST:-127.0.0.1}"
  mysql_port="${SYMPHONY_MYSQL_PORT:-3306}"
  mysql_db="$(mysql_name)"
fi

prepare_app() {
  local app="$1" key sqlite settings
  sqlite="$app/database/symphony.sqlite"
  key="base64:$(openssl rand -base64 32)"
  if $use_mysql; then
    settings="DB_CONNECTION=mysql
DB_HOST=$mysql_host
DB_PORT=$mysql_port
DB_DATABASE=$mysql_db
DB_USERNAME=$(env_quote "$SYMPHONY_MYSQL_USER")
DB_PASSWORD=$(env_quote "${SYMPHONY_MYSQL_PASSWORD:-}")"
    create_mysql_databases "$mysql_db" "${mysql_db}_test"
  else
    settings="DB_CONNECTION=sqlite
DB_DATABASE=$sqlite"
  fi
  settings="APP_ENV=local
APP_DEBUG=true
APP_KEY=$key
$settings
CACHE_STORE=file
QUEUE_CONNECTION=sync
MAIL_MAILER=log
BOOST_BROWSER_LOGS_WATCHER=false"

  cp "$app/.env.example" "$app/.env"
  SETTINGS="$settings" rewrite_env "$app/.env"
  exclude_untracked "$app" "$app/.env"
  if $use_mysql; then
    chmod 600 "$app/.env"
    if ! git -C "$app" ls-files --error-unmatch .env.testing >/dev/null 2>&1; then
      cp "$app/.env" "$app/.env.testing"
      SETTINGS="APP_ENV=testing
DB_DATABASE=${mysql_db}_test" rewrite_env "$app/.env.testing"
      exclude_untracked "$app" "$app/.env.testing"
    fi
  else
    mkdir -p "$app/database"
    touch "$sqlite"
    exclude_untracked "$app" "$sqlite"
  fi
  echo "laravel-env: prepared ${app#"$workspace"/}"
}

for dir in "$workspace" "$workspace"/*/; do
  dir="${dir%/}"
  [ -d "$dir" ] && [ ! -L "$dir" ] || continue
  case "$(basename "$dir")" in vendor | node_modules | .*) continue ;; esac
  [ -f "$dir/artisan" ] && [ -f "$dir/.env.example" ] && [ ! -e "$dir/.env" ] && [ ! -L "$dir/.env" ] || continue
  prepare_app "$dir"
done
