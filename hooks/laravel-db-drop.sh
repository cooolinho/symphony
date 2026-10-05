#!/usr/bin/env bash
# Drops the workspace's MySQL development and test database. Run from hooks.before_remove.
# No-op unless SYMPHONY_LARAVEL_DB=mysql; missing databases are not an error.
set -euo pipefail

[ "${SYMPHONY_LARAVEL_DB:-}" = mysql ] || exit 0

: "${SYMPHONY_MYSQL_USER:?laravel-db-drop: SYMPHONY_MYSQL_USER is required}"
host="${SYMPHONY_MYSQL_HOST:-127.0.0.1}"
port="${SYMPHONY_MYSQL_PORT:-3306}"
name="symphony_$(printf '%s' "${SYMPHONY_WORKSPACE_KEY:?laravel-db-drop: SYMPHONY_WORKSPACE_KEY is required}" | sha256sum | cut -c1-12)"

for db in "$name" "${name}_test"; do
  if ! MYSQL_PWD="${SYMPHONY_MYSQL_PASSWORD:-}" mysql --host="$host" --port="$port" --user="$SYMPHONY_MYSQL_USER" \
    --execute="DROP DATABASE IF EXISTS \`$db\`"; then
    echo "laravel-db-drop: DROP DATABASE $db failed on $host:$port as $SYMPHONY_MYSQL_USER" >&2
    exit 1
  fi
done
echo "laravel-db-drop: dropped $name and ${name}_test"
