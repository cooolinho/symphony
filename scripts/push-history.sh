#!/usr/bin/env bash
# Pushes the local Symphony history (repository logs, session transcripts, issue archives) to a Symphony container
# running on another machine and merges it with what is there (scripts/merge-history.ts); --replace drops the
# server's history first. See docs/docker.md.
#
#   scripts/push-history.sh [--replace] [--yes] [--no-backup] [--dry-run]
#
# Environment:
#   SYMPHONY_CONTAINER     container name on server   (default symphony; e.g. symphony-symphony-1)
#   SYMPHONY_REMOTE        ssh target                 (required; e.g. user@host)
#   SYMPHONY_LOCAL_STATE   local log dir              (default $SYMPHONY_LOG_DIR, else ~/.local/state/symphony)
# SYMPHONY_CONTAINER, SYMPHONY_REMOTE and SYMPHONY_LOCAL_STATE may also be set in the .env next to the repo root;
# the shell environment takes precedence.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

die() {
  printf 'push-history: %s\n' "$*" >&2
  exit 1
}

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
[[ -n "$REMOTE" ]] || die "SYMPHONY_REMOTE is not set (pass as env var or in .env)"
LOCAL_STATE="${SYMPHONY_LOCAL_STATE:-$(env_file_value SYMPHONY_LOCAL_STATE)}"
LOCAL_STATE="${LOCAL_STATE:-${SYMPHONY_LOG_DIR:-$HOME/.local/state/symphony}}"
[[ "$LOCAL_STATE" = /* ]] || LOCAL_STATE="$REPO_ROOT/$LOCAL_STATE"
CONTAINER_STATE=/home/symphony/.local/state/symphony # SYMPHONY_LOG_DIR in docker-compose.yml

assume_yes=false
replace=false
backup=true
backup_file=
dry_run=false

usage() {
  sed -n '2,11p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

for arg in "$@"; do
  case "$arg" in
    --replace) replace=true ;;
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
for name in repositories sessions issues; do
  [[ -d "$LOCAL_STATE/$name" ]] && dirs+=("$name")
done
((${#dirs[@]} > 0)) || die "none of repositories/, sessions/, issues/ in $LOCAL_STATE"

if pgrep -f 'node.*src/cli\.ts' >/dev/null; then
  die "a local Symphony is still running; stop it first so the transferred state is complete"
fi

local_files="$(cd "$LOCAL_STATE" && find "${dirs[@]}" -type f | wc -l)"
local_logs="$(find "$LOCAL_STATE/repositories" -maxdepth 1 -name '*.log' 2>/dev/null | wc -l)"
local_sessions="$(find "$LOCAL_STATE/sessions" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l)"
local_issues="$(find "$LOCAL_STATE/issues" -maxdepth 1 -name '*.json' 2>/dev/null | wc -l)"
local_size="$(du -shc "${dirs[@]/#/$LOCAL_STATE/}" | tail -n 1 | cut -f1)"

printf 'Local state:  %s\n' "$LOCAL_STATE"
printf '              %s repository logs, %s sessions, %s issue archives, %s files (%s)\n' "$local_logs" "$local_sessions" "$local_issues" "$local_files" "$local_size"
printf 'Target:       container %s on %s (volume state)\n' "$CONTAINER" "$REMOTE"
if $replace; then printf 'Mode:         replace %s on the server (--replace)\n' "${dirs[*]}"; else printf 'Mode:         merge into the server history (%s)\n' "${dirs[*]}"; fi
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

# Streams the local state and merge-history.ts into a one-off container, which unpacks both under /tmp (removed with
# the container) and merges them into the volume. $1 runs in the state directory first (--replace: rm -rf), further
# arguments go to merge-history.ts. Its summary goes to stdout; a failed verification fails the call.
push_and_merge() {
  local prepare="$1"
  shift
  tar czf - -C "$LOCAL_STATE" "${dirs[@]}" -C "$REPO_ROOT/scripts" merge-history.ts \
    | ssh_remote "$remote_run bash $remote_image -c 'set -e; tmp=\$(mktemp -d); tar xzf - -C \$tmp; cd $CONTAINER_STATE; $prepare node \$tmp/merge-history.ts --from \$tmp --into $CONTAINER_STATE $*'"
}

ssh_remote "docker inspect -f '{{.Config.Image}}' $CONTAINER" >/dev/null \
  || die "cannot reach $REMOTE, or it has no container named '$CONTAINER' (see: docker ps -a; set SYMPHONY_CONTAINER)"

if $dry_run; then
  if $replace; then
    printf '\nDry run, nothing changed. Would do on %s:\n' "$REMOTE"
    printf '  1. docker stop %s\n' "$CONTAINER"
    ! $backup || printf '  2. tar czf ~/symphony-state-backup-<timestamp>.tgz of %s\n' "$CONTAINER_STATE"
    printf '  3. rm -rf %s in %s, then copy the local history there (%s files)\n' "${dirs[*]}" "$CONTAINER_STATE" "$local_files"
    printf '  4. verify, docker start %s\n' "$CONTAINER"
  else
    printf '\nDry run: transferring to a throwaway container to count what is new (the server keeps running) ...\n'
    push_and_merge '' --dry-run || die "dry run failed"
    if $backup; then step='backs up the server state'; else step='skips the backup (--no-backup)'; fi
    printf '\nA real run stops %s, %s, merges and starts it again.\n' "$CONTAINER" "$step"
  fi
  exit 0
fi

if ! $assume_yes; then
  [[ -t 0 ]] || die "not a terminal; pass --yes to confirm"
  if $replace; then question='Replace the history on the server?'; else question='Merge the local history into the server history?'; fi
  read -r -p $'\n'"$question [y/N] " answer
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

printf 'Transferring and %s %s ...\n' "$($replace && printf replacing || printf merging)" "${dirs[*]}"
prepare=
! $replace || prepare="rm -rf ${dirs[*]};"
push_and_merge "$prepare" || die "transfer or merge failed${backup_file:+ (backup: ~/$backup_file on the server)}"

restart_remote

printf '\nDone. Check the Symphony dashboard logs (period "all").\n'
[[ -z "$backup_file" ]] || printf 'Previous server state: %s:~/%s\n' "$REMOTE" "$backup_file"
