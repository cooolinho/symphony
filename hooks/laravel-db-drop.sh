#!/usr/bin/env bash
# Drops the workspace's MySQL databases. Run from hooks.before_remove.
# With SYMPHONY_LARAVEL_DB=mysql: the development and test database (laravel-env.sh). With SYMPHONY_MYSQL_USER: also
# the database of the full CI check (checks/laravel.sh --full with SYMPHONY_CI_DB=mysql), left behind only by a killed
# check. No-op without either; missing databases are not an error.
set -euo pipefail

name="symphony_$(printf '%s' "${SYMPHONY_WORKSPACE_KEY:?laravel-db-drop: SYMPHONY_WORKSPACE_KEY is required}" | sha256sum | cut -c1-12)"
databases=()
if [ "${SYMPHONY_LARAVEL_DB:-}" = mysql ]; then
  : "${SYMPHONY_MYSQL_USER:?laravel-db-drop: SYMPHONY_MYSQL_USER is required}"
  databases+=("$name" "${name}_test")
fi
[ -n "${SYMPHONY_MYSQL_USER:-}" ] && databases+=("${name}_ci")
[ "${#databases[@]}" -gt 0 ] || exit 0

host="${SYMPHONY_MYSQL_HOST:-127.0.0.1}"
port="${SYMPHONY_MYSQL_PORT:-3306}"
for db in "${databases[@]}"; do
  if ! MYSQL_PWD="${SYMPHONY_MYSQL_PASSWORD:-}" mysql --host="$host" --port="$port" --user="$SYMPHONY_MYSQL_USER" \
    --execute="DROP DATABASE IF EXISTS \`$db\`"; then
    echo "laravel-db-drop: DROP DATABASE $db failed on $host:$port as $SYMPHONY_MYSQL_USER" >&2
    exit 1
  fi
done
echo "laravel-db-drop: dropped ${databases[*]}"
