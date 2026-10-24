#!/usr/bin/env bash
# Runs a repository's own check: `.symphony/checks/<name>.sh`, read from the base branch, so a pull request cannot
# weaken the check of its own merge (a changed script applies once it is merged). Without that script it runs the
# fallback command after `--`, without one it is skipped (exit 78).
#
#   repo.sh [--lock] <name> [-- fallback command…]
#
# --lock runs one check of this name per repository at a time (fixed compose projects, ports and networks).
# With SYMPHONY_CI_DOCKER_HOST (compose profile "ci") it sets DOCKER_HOST, DOCKER_TLS_VERIFY and DOCKER_CERT_PATH for
# the script, plus SYMPHONY_DOCKER_HOST_IP, the address of ports the daemon publishes. Agents never get these.
set -u
# shellcheck source=checks/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

lock=false
if [ "${1:-}" = --lock ]; then
  lock=true
  shift
fi
name=${1:-}
[ -n "$name" ] || env_problem "usage: repo.sh [--lock] <name> [-- fallback command]"
shift
[ "${1:-}" = -- ] && shift

require_clean_and_pushed
base=$(base_branch)
git fetch -q origin "$base" 2>/dev/null || env_problem "git fetch origin $base failed"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
if git show "origin/$base:.symphony/checks/$name.sh" > "$work/check.sh" 2>/dev/null; then
  command=(bash "$work/check.sh")
  echo "== $name: .symphony/checks/$name.sh from origin/$base"
elif [ "$#" -gt 0 ]; then
  command=("$@")
else
  skip "$name: no .symphony/checks/$name.sh on origin/$base; skipped"
fi

if [ -n "${SYMPHONY_CI_DOCKER_HOST:-}" ]; then
  export DOCKER_HOST="$SYMPHONY_CI_DOCKER_HOST"
  if [ -n "${SYMPHONY_CI_DOCKER_CERT_PATH:-}" ]; then
    export DOCKER_TLS_VERIFY=1 DOCKER_CERT_PATH="$SYMPHONY_CI_DOCKER_CERT_PATH"
  fi
  case "$DOCKER_HOST" in
    tcp://*)
      daemon=${DOCKER_HOST#tcp://}
      daemon=${daemon%%:*}
      ip=$(getent ahostsv4 "$daemon" 2>/dev/null | awk 'NR == 1 { print $1 }')
      [ -n "$ip" ] || env_problem "cannot resolve the Docker daemon host $daemon"
      export SYMPHONY_DOCKER_HOST_IP="$ip"
      ;;
    *) export SYMPHONY_DOCKER_HOST_IP=127.0.0.1 ;;
  esac
fi

if $lock; then
  locks="${TMPDIR:-/tmp}/symphony-checks"
  mkdir -p "$locks" || env_problem "cannot create $locks"
  repository=${SYMPHONY_ISSUE_REPOSITORY:-$(basename "$PWD")}
  # The lock goes with the process: a check killed at its timeout releases it.
  command=(flock "$locks/${repository//\//_}-$name.lock" "${command[@]}")
fi
"${command[@]}"
