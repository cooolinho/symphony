#!/usr/bin/env bash
# Gives every Laravel app in the workspace its own .env and SQLite database.
# Run from hooks.after_create after the clone. Silent no-op when there is no app to prepare.
set -euo pipefail

workspace="$(cd "${SYMPHONY_WORKSPACE:-$(pwd)}" && pwd -P)"

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

prepare_app() {
  local app="$1" key sqlite settings
  sqlite="$app/database/symphony.sqlite"
  key="base64:$(openssl rand -base64 32)"
  settings="APP_ENV=local
APP_DEBUG=true
APP_KEY=$key
DB_CONNECTION=sqlite
DB_DATABASE=$sqlite
CACHE_STORE=file
QUEUE_CONNECTION=sync
MAIL_MAILER=log
BOOST_BROWSER_LOGS_WATCHER=false"

  cp "$app/.env.example" "$app/.env"
  SETTINGS="$settings" rewrite_env "$app/.env"
  mkdir -p "$app/database"
  touch "$sqlite"
  exclude_untracked "$app" "$app/.env"
  exclude_untracked "$app" "$sqlite"
  echo "laravel-env: prepared ${app#"$workspace"/}"
}

for dir in "$workspace" "$workspace"/*/; do
  dir="${dir%/}"
  [ -d "$dir" ] && [ ! -L "$dir" ] || continue
  case "$(basename "$dir")" in vendor | node_modules | .*) continue ;; esac
  [ -f "$dir/artisan" ] && [ -f "$dir/.env.example" ] && [ ! -e "$dir/.env" ] && [ ! -L "$dir/.env" ] || continue
  prepare_app "$dir"
done
