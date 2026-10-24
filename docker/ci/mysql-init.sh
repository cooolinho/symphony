#!/bin/bash
# Init script of the mysql sidecar (compose profile "ci"), run once by the mysql image on an empty data directory.
# Creates the account hooks/laravel-env.sh and the CI checks use (SYMPHONY_MYSQL_USER / SYMPHONY_MYSQL_PASSWORD),
# restricted to the symphony_% databases (one pair per workspace, plus the suffixed ones of php artisan test --parallel).
# mysql_native_password: the symphony image's mysql client is MariaDB's (default-mysql-client), which cannot be relied
# on for MySQL 8's caching_sha2_password.
# The data directory is a tmpfs, so this runs on every start of the container.
set -euo pipefail

: "${SYMPHONY_MYSQL_USER:?mysql-init: SYMPHONY_MYSQL_USER is required}"
: "${SYMPHONY_MYSQL_PASSWORD:?mysql-init: SYMPHONY_MYSQL_PASSWORD is required}"
: "${MYSQL_ROOT_PASSWORD:?mysql-init: MYSQL_ROOT_PASSWORD is required}"

# SQL string literal: backslashes first, then single quotes.
sql_quote() {
  local v=${1//\\/\\\\}
  printf "'%s'" "${v//\'/\'\'}"
}

user=$(sql_quote "$SYMPHONY_MYSQL_USER")
password=$(sql_quote "$SYMPHONY_MYSQL_PASSWORD")

# The SQL goes in on stdin and the root password in MYSQL_PWD, so neither shows up in the process list.
MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql --protocol=socket --user=root <<SQL
CREATE USER IF NOT EXISTS ${user}@'%' IDENTIFIED WITH mysql_native_password BY ${password};
GRANT ALL PRIVILEGES ON \`symphony\\_%\`.* TO ${user}@'%';
FLUSH PRIVILEGES;
SQL
echo "mysql-init: user ${SYMPHONY_MYSQL_USER} may use the symphony_% databases"
