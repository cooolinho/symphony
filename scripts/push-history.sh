#!/usr/bin/env bash
# Pushes the local Symphony history (repository logs and session transcripts) to a Symphony container
# running on another machine, replacing what is there. See docs/docker.md.
#
#   scripts/push-history.sh [--yes] [--no-backup] [--dry-run]
#
# Environment:
#   SYMPHONY_CONTAINER     container name on server   (default symphony; e.g. symphony-symphony-1)
#   SYMPHONY_REMOTE        ssh target                 (default cooolinho@docker.lan)
#   SYMPHONY_LOCAL_STATE   local log dir              (default $SYMPHONY_LOG_DIR, else ~/.local/state/symphony)
# SYMPHONY_CONTAINER, SYMPHONY_REMOTE and SYMPHONY_LOCAL_STATE may also be set in the .env next to the repo root;
# the shell environment takes precedence.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Value of NAME from the repo's .env (last assignment wins, surrounding quotes removed); empty if absent.
# The file is parsed, not sourced: it holds secrets and values like htpasswd hashes with "$".
env_file_value() {
  local line value=
  [[ -f "$REPO_ROOT/.env" ]] || return 0
  while IFS= read -r line; do
    if [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?"$1"[[:space:]]*=[[:space:]]*(.*)$ ]]; then
      value="${BASH_REMATCH[2]}"
      value="${value%"${value##*[![:space:]]}"}"
      if [[ "$value" =~ ^\"(.*)\"$ || "$value" =~ ^\'(.*)\'$ ]]; then value="${BASH_REMATCH[1]}"; fi
    fi
  done <"$REPO_ROOT/.env"
  printf '%s' "$value"
}

CONTAINER="${SYMPHONY_CONTAINER:-$(env_file_value SYMPHONY_CONTAINER)}"
CONTAINER="${CONTAINER:-symphony}"
REMOTE="${SYMPHONY_REMOTE:-$(env_file_value SYMPHONY_REMOTE)}"
REMOTE="${REMOTE:-cooolinho@docker.lan}"
LOCAL_STATE="${SYMPHONY_LOCAL_STATE:-$(env_file_value SYMPHONY_LOCAL_STATE)}"
LOCAL_STATE="${LOCAL_STATE:-${SYMPHONY_LOG_DIR:-$HOME/.local/state/symphony}}"
[[ "$LOCAL_STATE" = /* ]] || LOCAL_STATE="$REPO_ROOT/$LOCAL_STATE"
CONTAINER_STATE=/home/symphony/.local/state/symphony # SYMPHONY_LOG_DIR in docker-compose.yml

assume_yes=false
backup=true
backup_file=
dry_run=false

usage() {
  sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

die() {
  printf 'push-history: %s\n' "$*" >&2
  exit 1
}

for arg in "$@"; do
  case "$arg" in
    --yes | -y) assume_yes=true ;;
    --no-backup) backup=false ;;
    --dry-run) dry_run=true ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown option: $arg (see --help)" ;;
  esac
done

[[ "$CONTAINER" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || die "invalid container name: $CONTAINER"

# --- local state ---------------------------------------------------------------------------------------------------

[[ -d "$LOCAL_STATE" ]] || die "no local state directory: $LOCAL_STATE"

dirs=()
for name in repositories sessions; do
  [[ -d "$LOCAL_STATE/$name" ]] && dirs+=("$name")
done
((${#dirs[@]} > 0)) || die "neither repositories/ nor sessions/ in $LOCAL_STATE"

if pgrep -f 'node.*src/cli\.ts' >/dev/null; then
  die "a local Symphony is still running; stop it first so the transferred state is complete"
fi

local_files="$(cd "$LOCAL_STATE" && find "${dirs[@]}" -type f | wc -l)"
local_logs="$(find "$LOCAL_STATE/repositories" -maxdepth 1 -name '*.log' 2>/dev/null | wc -l)"
local_sessions="$(find "$LOCAL_STATE/sessions" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l)"
local_size="$(du -shc "${dirs[@]/#/$LOCAL_STATE/}" | tail -n 1 | cut -f1)"

printf 'Local state:  %s\n' "$LOCAL_STATE"
printf '              %s repository logs, %s sessions, %s files (%s)\n' "$local_logs" "$local_sessions" "$local_files" "$local_size"
printf 'Target:       container %s on %s (volume state)\n' "$CONTAINER" "$REMOTE"
printf 'Replaces:     %s on the server\n' "${dirs[*]}"
if $backup; then printf 'Backup:       ~/symphony-state-backup-<timestamp>.tgz on the server\n'; else printf 'Backup:       none (--no-backup)\n'; fi

# --- remote commands -----------------------------------------------------------------------------------------------

# One-off container from the target container's image with its volumes (--volumes-from works on a stopped container),
# as the image's user (so file ownership is right). The entrypoint is bypassed (it demands secrets). Being a plain
# "docker run", it carries no Traefik labels. $(...) is expanded by the remote shell.
remote_run="docker run --rm -i --volumes-from $CONTAINER --entrypoint"
remote_image="\$(docker inspect -f '{{.Config.Image}}' $CONTAINER)"

# One connection for all calls (a single password/passphrase prompt); the last call closes it.
ctl_dir="$(mktemp -d)"
ssh_remote() {
  ssh -o ControlMaster=auto -o ControlPath="$ctl_dir/cm" -o ControlPersist=10m "$REMOTE" "$@"
}

stopped=false
restart_remote() {
  if $stopped; then
    printf 'Starting %s on %s ...\n' "$CONTAINER" "$REMOTE" >&2
    ssh_remote "docker start $CONTAINER" >&2 || printf 'push-history: START FAILED, run "docker start %s" on %s\n' "$CONTAINER" "$REMOTE" >&2
    stopped=false
  fi
}
cleanup() {
  restart_remote
  ssh -o ControlPath="$ctl_dir/cm" -O exit "$REMOTE" 2>/dev/null || true
  rm -rf "$ctl_dir"
}
trap cleanup EXIT

ssh_remote "docker inspect -f '{{.Config.Image}}' $CONTAINER" >/dev/null \
  || die "cannot reach $REMOTE, or it has no container named '$CONTAINER' (see: docker ps -a; set SYMPHONY_CONTAINER)"

if $dry_run; then
  printf '\nDry run, nothing changed. Would do on %s:\n' "$REMOTE"
  printf '  1. docker stop %s\n' "$CONTAINER"
  ! $backup || printf '  2. tar czf ~/symphony-state-backup-<timestamp>.tgz of %s\n' "$CONTAINER_STATE"
  printf '  3. rm -rf %s in %s, then extract the local archive there\n' "${dirs[*]}" "$CONTAINER_STATE"
  printf '  4. compare file count (%s), docker start %s\n' "$local_files" "$CONTAINER"
  exit 0
fi

if ! $assume_yes; then
  [[ -t 0 ]] || die "not a terminal; pass --yes to confirm"
  read -r -p $'\nReplace the history on the server? [y/N] ' answer
  [[ "$answer" =~ ^[yYjJ]$ ]] || die "aborted"
fi

# --- transfer ------------------------------------------------------------------------------------------------------

printf 'Stopping %s on %s (waits for running agents, up to 120 s) ...\n' "$CONTAINER" "$REMOTE"
ssh_remote "docker stop $CONTAINER" >&2
stopped=true

if $backup; then
  stamp="$(date +%Y%m%d-%H%M%S)"
  backup_file="symphony-state-backup-$stamp.tgz"
  printf 'Backing up the server state to ~/%s ...\n' "$backup_file"
  ssh_remote "$remote_run tar $remote_image czf - -C $CONTAINER_STATE . > \"\$HOME/$backup_file\""
fi

printf 'Transferring %s ...\n' "${dirs[*]}"
tar czf - -C "$LOCAL_STATE" "${dirs[@]}" \
  | ssh_remote "$remote_run bash $remote_image -c 'cd $CONTAINER_STATE && rm -rf ${dirs[*]} && tar xzf -'"

remote_files="$(ssh_remote "$remote_run bash $remote_image -c 'cd $CONTAINER_STATE && find ${dirs[*]} -type f | wc -l'" | tr -d '[:space:]')"
if [[ "$remote_files" != "$local_files" ]]; then
  die "file count differs: $local_files local, ${remote_files:-?} on the server${backup_file:+ (backup: ~/$backup_file on the server)}"
fi
printf 'Verified: %s files on the server.\n' "$remote_files"

restart_remote

printf '\nDone. Check http://symphony.docker.lan/logs (period "all").\n'
[[ -z "$backup_file" ]] || printf 'Previous server state: %s:~/%s\n' "$REMOTE" "$backup_file"
