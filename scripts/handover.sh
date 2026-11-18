#!/usr/bin/env bash
# Hands Symphony over between the server and this machine, so only one of them works the board at a time. pull stops
# the server and starts the same version here with its brain vault, Obsidian settings and logs; push brings the vault,
# the settings and every log written here back and starts the server again. See docs/docker.md.
#
#   scripts/handover.sh pull|push|status [--yes] [--dry-run] [--no-backup] [--force] [--version vX.Y.Z]
#
# Environment (shell or the .env next to the repo root; the shell wins):
#   SYMPHONY_REMOTE           ssh target                        (required; e.g. user@host)
#   SYMPHONY_CONTAINER        Symphony container on the server  (default symphony)
#   SYMPHONY_HANDOVER_DIR     local checkout that runs Symphony (default ../symphony-<tag>, a git worktree)
#   SYMPHONY_HANDOVER_PROJECT local Compose project name        (default symphony)
#   SYMPHONY_HANDOVER_BACKUPS local backup directory            (default ~/symphony-handover-backups)
#   SYMPHONY_HANDOVER_CI_SUBNET subnet of the local "ci" network (default: the server's SYMPHONY_CI_SUBNET or
#                             172.31.250.0/24, or the first free 10.250.N.0/24 when that overlaps a Docker network here)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

die() {
  printf 'handover: %s\n' "$*" >&2
  exit 1
}

note() {
  printf '%s\n' "$*" >&2
}

# Value of NAME from an env file (last assignment wins, surrounding quotes removed); empty if absent.
# The file is parsed, not sourced: it holds secrets and values like htpasswd hashes with "$".
env_value() {
  local file="$1" name="$2" line value=
  [[ -f "$file" ]] || return 0
  while IFS= read -r line; do
    if [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?"$name"[[:space:]]*=[[:space:]]*(.*)$ ]]; then
      value="${BASH_REMATCH[2]}"
      value="${value%"${value##*[![:space:]]}"}"
      if [[ "$value" =~ ^\"(.*)\"$ || "$value" =~ ^\'(.*)\'$ ]]; then value="${BASH_REMATCH[1]}"; fi
    fi
  done <"$file"
  printf '%s' "$value"
}

# Sets NAME=VALUE in an env file: every earlier assignment of NAME is removed, the new one appended.
env_set() {
  local file="$1" name="$2" value="$3" tmp
  tmp="$(mktemp "$file.XXXXXX")"
  grep -Ev "^[[:space:]]*(export[[:space:]]+)?${name}[[:space:]]*=" "$file" >"$tmp" || true
  printf '%s=%s\n' "$name" "$value" >>"$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$file"
}

setting() {
  local value="${!1:-}"
  [[ -n "$value" ]] || value="$(env_value "$REPO_ROOT/.env" "$1")"
  printf '%s' "$value"
}

usage() {
  sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

command=
assume_yes=false
dry_run=false
backup=true
force=false
tag=
while (($# > 0)); do
  case "$1" in
    pull | push | status) [[ -z "$command" ]] || die "only one command (see --help)"; command="$1" ;;
    --yes | -y) assume_yes=true ;;
    --dry-run) dry_run=true ;;
    --no-backup) backup=false ;;
    --force) force=true ;;
    --version) shift; tag="${1:-}"; [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "--version expects a tag like v1.5.1" ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
  shift
done
[[ -n "$command" ]] || { usage >&2; exit 1; }

REMOTE="$(setting SYMPHONY_REMOTE)"
[[ -n "$REMOTE" ]] || die "SYMPHONY_REMOTE is not set (pass as env var or in .env)"
CONTAINER="$(setting SYMPHONY_CONTAINER)"
CONTAINER="${CONTAINER:-symphony}"
PROJECT="$(setting SYMPHONY_HANDOVER_PROJECT)"
PROJECT="${PROJECT:-symphony}"
BACKUPS="$(setting SYMPHONY_HANDOVER_BACKUPS)"
BACKUPS="${BACKUPS:-$HOME/symphony-handover-backups}"
CI_SUBNET="$(setting SYMPHONY_HANDOVER_CI_SUBNET)"
[[ -z "$CI_SUBNET" || "$CI_SUBNET" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}/[0-9]{1,2}$ ]] || die "invalid SYMPHONY_HANDOVER_CI_SUBNET: $CI_SUBNET (expected e.g. 10.250.0.0/24)"
NAME_RE='^[A-Za-z0-9][A-Za-z0-9_.-]*$'
[[ "$CONTAINER" =~ $NAME_RE ]] || die "invalid container name: $CONTAINER"
[[ "$PROJECT" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || die "invalid Compose project name: $PROJECT"

# Paths inside the Symphony image (docker-compose.yml): the volumes are found by these mount points.
BRAIN_PATH=/home/symphony/brain
STATE_PATH=/home/symphony/.local/state/symphony
WATCHDOG_PATH=/home/symphony/.local/state/symphony-watchdog
OBSIDIAN_PATH=/config
LOCAL_IMAGE=symphony:local
MARKER='.symphony-handover'
REMOTE_MERGE='.symphony-handover-merge.ts'

# --- ssh -----------------------------------------------------------------------------------------------------------

# One connection for all calls (a single password/passphrase prompt); cleanup closes it.
ctl_dir="$(mktemp -d)"
ssh_remote() {
  ssh -o ControlMaster=auto -o ControlPath="$ctl_dir/cm" -o ControlPersist=10m "$REMOTE" "$@"
}

# Rollback on failure, so the board always has exactly one instance: until a handover completes, the side that was
# stopped is started again (and the other one stopped).
rollback_remote=() # pull: containers to start on the server again
rollback_local=false # push: start the local stack again
remove_remote_merge=false
DIR=
cleanup() {
  if ((${#rollback_remote[@]} > 0)); then
    [[ -z "$DIR" ]] || local_compose stop >&2 || true
    note "Starting on $REMOTE again: ${rollback_remote[*]} ..."
    ssh_remote "docker start ${rollback_remote[*]} && rm -f ~/$MARKER" >&2 \
      || note "handover: START FAILED, run docker start ${rollback_remote[*]} on $REMOTE"
  fi
  if $rollback_local; then
    note "Starting Symphony here again ..."
    local_compose up -d >&2 || note "handover: START FAILED, run docker compose -p $PROJECT -f docker-compose.local.yml up -d in $DIR"
  fi
  if $remove_remote_merge; then ssh_remote "rm -f ~/$REMOTE_MERGE" || true; fi
  ssh -o ControlPath="$ctl_dir/cm" -O exit "$REMOTE" 2>/dev/null || true
  rm -rf "$ctl_dir"
}
trap cleanup EXIT

# --- server --------------------------------------------------------------------------------------------------------

remote_image=
remote_project=
remote_workdir=
declare -A remote_volume=()
remote_others=()

# Container of a Compose service in the server's project; empty when there is none.
remote_service() {
  ssh_remote "docker ps -a --filter label=com.docker.compose.project=$remote_project --filter label=com.docker.compose.service=$1 --format '{{.Names}}'" | head -n 1
}

# "<mount point>=<volume>" lines of a container's named volumes.
remote_mounts() {
  ssh_remote "docker inspect -f '{{range .Mounts}}{{if eq .Type \"volume\"}}{{.Destination}}={{.Name}}{{println}}{{end}}{{end}}' $1"
}

discover_remote() {
  remote_image="$(ssh_remote "docker inspect -f '{{.Config.Image}}' $CONTAINER")" \
    || die "cannot reach $REMOTE, or it has no container named '$CONTAINER' (see: docker ps -a; set SYMPHONY_CONTAINER)"
  remote_project="$(ssh_remote "docker inspect -f '{{index .Config.Labels \"com.docker.compose.project\"}}' $CONTAINER")"
  remote_workdir="$(ssh_remote "docker inspect -f '{{index .Config.Labels \"com.docker.compose.project.working_dir\"}}' $CONTAINER")"
  [[ "$remote_project" =~ $NAME_RE ]] || die "$CONTAINER on $REMOTE was not started by Docker Compose"
  local line
  while IFS= read -r line; do
    case "${line%%=*}" in
      "$BRAIN_PATH") remote_volume[brain]="${line#*=}" ;;
      "$STATE_PATH") remote_volume[state]="${line#*=}" ;;
      "$WATCHDOG_PATH") remote_volume[watchdog-state]="${line#*=}" ;;
    esac
  done < <(remote_mounts "$CONTAINER")
  [[ -n "${remote_volume[brain]:-}" ]] || die "$CONTAINER on $REMOTE has no volume at $BRAIN_PATH"
  [[ -n "${remote_volume[state]:-}" ]] || die "$CONTAINER on $REMOTE has no volume at $STATE_PATH"
  local obsidian watchdog
  obsidian="$(remote_service obsidian)"
  watchdog="$(remote_service watchdog)"
  if [[ -n "$obsidian" ]]; then
    while IFS= read -r line; do
      [[ "${line%%=*}" != "$OBSIDIAN_PATH" ]] || remote_volume[obsidian-config]="${line#*=}"
    done < <(remote_mounts "$obsidian")
  fi
  # Stop order: whatever reads Symphony first, Obsidian last. The start order is the reverse.
  remote_others=()
  [[ -z "$watchdog" ]] || remote_others+=("$watchdog")
  remote_others+=("$CONTAINER")
  [[ -z "$obsidian" ]] || remote_others+=("$obsidian")
  local name
  for name in "${remote_volume[@]}" "${remote_others[@]}"; do
    [[ "$name" =~ $NAME_RE ]] || die "unexpected name on the server: $name"
  done
}

remote_running() {
  ssh_remote "docker inspect -f '{{.State.Running}}' $1" 2>/dev/null || printf 'false'
}

remote_version() {
  ssh_remote "docker run --rm --entrypoint cat $remote_image /app/package.json" \
    | sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1
}

# HEAD of the vault in a volume (empty without history). $1 runs the command (ssh_remote or local_sh), $2 image.
vault_head() {
  "$1" "docker run --rm --user 0 -v $3:/data:ro --entrypoint git $2 -c 'safe.directory=*' -C /data rev-parse --verify -q HEAD" 2>/dev/null || true
}

# True when commit $4 is an ancestor of (or equal to) HEAD of the vault in volume $3.
vault_contains() {
  "$1" "docker run --rm --user 0 -v $3:/data:ro --entrypoint git $2 -c 'safe.directory=*' -C /data merge-base --is-ancestor $4 HEAD" >/dev/null 2>&1
}

# --- this machine ---------------------------------------------------------------------------------------------------

local_sh() {
  bash -c "$1"
}

local_volume() {
  printf '%s_%s' "$PROJECT" "$1"
}

local_volume_exists() {
  docker volume inspect "$(local_volume "$1")" >/dev/null 2>&1
}

local_image_exists() {
  docker image inspect "$LOCAL_IMAGE" >/dev/null 2>&1
}

local_compose() {
  (cd "$DIR" && docker compose -p "$PROJECT" -f docker-compose.local.yml "$@")
}

# UID and GID of the image's user (symphony), as "uid:gid"; Obsidian's PUID/PGID follow the same values.
image_owner() {
  "$1" "docker run --rm --entrypoint sh $2 -c 'printf \"%s:%s\" \"\$(id -u)\" \"\$(id -g)\"'"
}

valid_head() {
  [[ -z "$1" || "$1" =~ ^[0-9a-f]{40,64}$ ]] || die "unexpected vault HEAD: $1"
}

confirm() {
  $assume_yes && return 0
  [[ -t 0 ]] || die "not a terminal; pass --yes to confirm"
  local answer
  read -r -p $'\n'"$1 [y/N] " answer
  [[ "$answer" =~ ^[yYjJ]$ ]] || die "aborted"
}

stamp="$(date +%Y%m%d-%H%M%S)"

# Shell snippet (for a container's sh -c) that unpacks stdin under /tmp and merges it into $1 as user $2.
merge_snippet() {
  printf "set -e; tmp=\$(mktemp -d); tar xzf - -C \$tmp; node /merge/merge-history.ts --from \$tmp --into %s; chown -R %s %s" "$1" "$2" "$1"
}

# Shell snippet that replaces the content of /data with the tar on stdin, owned by $1.
replace_snippet() {
  printf "set -e; find /data -mindepth 1 -delete; tar xzf - -C /data; chown -R %s /data" "$1"
}

# IPv4 address $1 as an integer.
ip_int() {
  local a b c d
  IFS=. read -r a b c d <<<"$1"
  printf '%s' $(((a << 24) | (b << 16) | (c << 8) | d))
}

# True when the IPv4 CIDRs $1 and $2 share an address.
cidr_overlaps() {
  local start1 end1 start2 end2 bits
  bits="${1#*/}"; start1="$(ip_int "${1%/*}")"; start1=$((start1 & ~((1 << (32 - bits)) - 1) & 0xFFFFFFFF)); end1=$((start1 + (1 << (32 - bits)) - 1))
  bits="${2#*/}"; start2="$(ip_int "${2%/*}")"; start2=$((start2 & ~((1 << (32 - bits)) - 1) & 0xFFFFFFFF)); end2=$((start2 + (1 << (32 - bits)) - 1))
  ((start1 <= end2 && start2 <= end1))
}

# "<network> <subnet>" lines of the local Docker networks' IPv4 subnets, without the project's own ci network.
local_subnets() {
  local id line name subnet
  for id in $(docker network ls -q 2>/dev/null); do
    line="$(docker network inspect -f '{{.Name}} {{range .IPAM.Config}}{{.Subnet}} {{end}}' "$id" 2>/dev/null)" || continue
    name="${line%% *}"
    [[ "$name" != "${PROJECT}_ci" ]] || continue
    for subnet in ${line#"$name"}; do
      [[ "$subnet" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}/[0-9]{1,2}$ ]] && printf '%s %s\n' "$name" "$subnet"
    done
  done
}

# Network (from local_subnets lines in $2) that CIDR $1 overlaps; fails when there is none.
subnet_conflict() {
  local name subnet
  while read -r name subnet; do
    [[ -n "$subnet" ]] || continue
    if cidr_overlaps "$1" "$subnet"; then printf '%s (%s)' "$name" "$subnet"; return 0; fi
  done <<<"$2"
  return 1
}

# Subnet of the local "ci" network: SYMPHONY_HANDOVER_CI_SUBNET as given (an overlap is an error), else the .env's
# SYMPHONY_CI_SUBNET or the Compose default, replaced by the first free 10.250.N.0/24 when it overlaps a network here.
choose_ci_subnet() {
  local taken conflict subnet n
  taken="$(local_subnets)"
  if [[ -n "$CI_SUBNET" ]]; then
    ! conflict="$(subnet_conflict "$CI_SUBNET" "$taken")" || die "SYMPHONY_HANDOVER_CI_SUBNET $CI_SUBNET overlaps the Docker network $conflict here"
    return 0
  fi
  subnet="$(env_value "$DIR/.env" SYMPHONY_CI_SUBNET)"
  subnet="${subnet:-172.31.250.0/24}"
  conflict="$(subnet_conflict "$subnet" "$taken")" || return 0
  for ((n = 0; n < 256; n++)); do
    if ! subnet_conflict "10.250.$n.0/24" "$taken" >/dev/null; then
      note "The ci subnet $subnet overlaps the Docker network $conflict here, using 10.250.$n.0/24 (SYMPHONY_HANDOVER_CI_SUBNET sets it)."
      CI_SUBNET="10.250.$n.0/24"
      return 0
    fi
  done
  die "the ci subnet $subnet overlaps the Docker network $conflict here and 10.250.0-255.0/24 are taken; set SYMPHONY_HANDOVER_CI_SUBNET"
}

resolve_dir() {
  DIR="$(setting SYMPHONY_HANDOVER_DIR)"
  DIR="${DIR:-$(dirname "$REPO_ROOT")/symphony-$tag}"
  [[ "$DIR" = /* ]] || DIR="$REPO_ROOT/$DIR"
}

# --- commands -------------------------------------------------------------------------------------------------------

cmd_status() {
  discover_remote
  local version name state marker local_head remote_head
  version="$(remote_version)"
  printf 'Server:       %s, container %s, image %s, version %s\n' "$REMOTE" "$CONTAINER" "$remote_image" "${version:-?}"
  for name in "${remote_others[@]}"; do
    state="stopped"
    [[ "$(remote_running "$name")" != true ]] || state="running"
    printf '              %-28s %s\n' "$name" "$state"
  done
  marker="$(ssh_remote "cat ~/$MARKER 2>/dev/null" || true)"
  if [[ -n "$marker" ]]; then printf 'Handed over:  %s\n' "$(printf '%s' "$marker" | head -n 1)"; else printf 'Handed over:  no (server is the active instance)\n'; fi
  tag="${tag:-v$version}"
  resolve_dir
  if [[ -f "$DIR/package.json" ]]; then
    printf 'Local:        %s, version %s\n' "$DIR" "$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$DIR/package.json" | head -n 1)"
  else
    printf 'Local:        %s (not set up; run pull)\n' "$DIR"
  fi
  docker ps -a --filter "label=com.docker.compose.project=$PROJECT" --format '              {{.Names}}  {{.State}}' 2>/dev/null || true
  remote_head="$(vault_head ssh_remote "$remote_image" "${remote_volume[brain]}")"
  local_head=
  if local_image_exists && local_volume_exists brain; then local_head="$(vault_head local_sh "$LOCAL_IMAGE" "$(local_volume brain)")"; fi
  valid_head "$remote_head"
  valid_head "$local_head"
  printf 'Vault HEAD:   server %s, local %s\n' "${remote_head:-none}" "${local_head:-none}"
  if [[ -z "$local_head" || -z "$remote_head" || "$local_head" == "$remote_head" ]]; then
    printf 'Vaults:       %s\n' "$([[ "$local_head" == "$remote_head" ]] && printf 'in sync' || printf 'one side has no vault')"
  elif vault_contains local_sh "$LOCAL_IMAGE" "$(local_volume brain)" "$remote_head"; then
    printf 'Vaults:       local is ahead (push brings it to the server)\n'
  elif vault_contains ssh_remote "$remote_image" "${remote_volume[brain]}" "$local_head"; then
    printf 'Vaults:       server is ahead (pull brings it here)\n'
  else
    printf 'Vaults:       diverged (both sides have commits the other lacks)\n'
  fi
}

cmd_pull() {
  discover_remote
  local version
  version="$(remote_version)"
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "cannot read the server's version (got '$version')"
  tag="${tag:-v$version}"
  [[ "$tag" == "v$version" ]] || note "Note: the server runs v$version, starting $tag here (--version)."
  resolve_dir

  local name running=()
  for name in "${remote_others[@]}"; do
    [[ "$(remote_running "$name")" != true ]] || running+=("$name")
  done
  local remote_head local_head=
  remote_head="$(vault_head ssh_remote "$remote_image" "${remote_volume[brain]}")"
  if local_image_exists && local_volume_exists brain; then local_head="$(vault_head local_sh "$LOCAL_IMAGE" "$(local_volume brain)")"; fi
  valid_head "$remote_head"
  valid_head "$local_head"
  # The local vault must not hold commits the server lacks (a push is missing): the copy would drop them.
  if [[ -n "$local_head" && "$local_head" != "$remote_head" ]] \
    && ! { [[ -n "$remote_head" ]] && vault_contains ssh_remote "$remote_image" "${remote_volume[brain]}" "$local_head"; }; then
    $force || die "the local vault has commits the server lacks (run push first, or --force to drop them; a backup is kept)"
    note "Warning: --force, the local vault's own commits are replaced (backup in $BACKUPS)."
  fi

  printf 'Server:       %s, %s (%s), running: %s\n' "$REMOTE" "$CONTAINER" "v$version" "${running[*]:-nothing}"
  printf 'Local:        %s at %s, Compose project %s\n' "$DIR" "$tag" "$PROJECT"
  printf 'Transfer:     brain vault (HEAD %s), Obsidian settings%s; logs merged (state, watchdog-state)\n' \
    "${remote_head:0:12}" "$([[ -n "${remote_volume[obsidian-config]:-}" ]] || printf ' (none on the server)')"
  if $backup; then printf 'Backup:       %s/%s-<volume>.tgz of the local volumes\n' "$BACKUPS" "$stamp"; else printf 'Backup:       none (--no-backup)\n'; fi
  note "Agents running on the server are stopped (docker stop waits up to 120 s); unpushed work stays in its workspaces volume."

  if $dry_run; then
    printf '\nDry run, nothing changed. Would:\n'
    printf '  1. set up %s (git worktree at %s), fetch the .env from %s:%s, build %s\n' "$DIR" "$tag" "$REMOTE" "$remote_workdir" "$LOCAL_IMAGE"
    printf '  2. stop on the server: %s; leave ~/%s there\n' "${remote_others[*]}" "$MARKER"
    printf '  3. back up and replace the local brain and obsidian-config volumes, merge the server logs into the local ones\n'
    printf '  4. verify the vault HEAD, docker compose -p %s -f docker-compose.local.yml up -d\n' "$PROJECT"
    return 0
  fi
  confirm 'Stop Symphony on the server and start it here?'

  # 1. Checkout, .env and image: nothing on the server is touched yet.
  if [[ ! -e "$DIR" ]]; then
    git -C "$REPO_ROOT" rev-parse -q --verify "refs/tags/$tag" >/dev/null || git -C "$REPO_ROOT" fetch --tags --quiet
    git -C "$REPO_ROOT" rev-parse -q --verify "refs/tags/$tag" >/dev/null || die "no tag $tag in $REPO_ROOT"
    note "Creating the worktree $DIR at $tag ..."
    git -C "$REPO_ROOT" worktree add --detach --quiet "$DIR" "$tag"
  else
    [[ -f "$DIR/docker-compose.local.yml" ]] || die "$DIR exists but is no Symphony checkout"
    if [[ "$(git -C "$DIR" rev-parse HEAD)" != "$(git -C "$REPO_ROOT" rev-parse "$tag^{commit}" 2>/dev/null)" ]]; then
      [[ -z "$(git -C "$DIR" status --porcelain)" ]] || die "$DIR is not at $tag and has local changes"
      note "Checking out $tag in $DIR ..."
      git -C "$DIR" checkout --detach --quiet "$tag"
    fi
  fi
  [[ "$remote_workdir" = /* && "$remote_workdir" != *"'"* ]] || die "unexpected Compose directory on the server: $remote_workdir"
  # The server's SSH key, not this repository's: only the key GitHub knows for the server's repositories can clone them
  # (a local key is often a deploy key of a single repository, and the clone fails with "Repository not found").
  local key_tmp
  mkdir -p "$DIR/secrets"
  key_tmp="$(mktemp "$DIR/secrets/.ssh_key.handover.XXXXXX")"
  chmod 600 "$key_tmp"
  ssh_remote "cat '$remote_workdir/secrets/ssh_key'" >"$key_tmp" && [[ -s "$key_tmp" ]] \
    || { rm -f "$key_tmp"; die "cannot read $remote_workdir/secrets/ssh_key on $REMOTE"; }
  if [[ -f "$DIR/secrets/ssh_key" ]] && ! cmp -s "$key_tmp" "$DIR/secrets/ssh_key"; then
    chmod u+w "$DIR/secrets/ssh_key"
    mv "$DIR/secrets/ssh_key" "$DIR/secrets/ssh_key.bak"
  fi
  chmod 400 "$key_tmp"
  mv -f "$key_tmp" "$DIR/secrets/ssh_key"
  ssh_remote "cat '$remote_workdir/secrets/ssh_key.pub' 2>/dev/null" >"$DIR/secrets/ssh_key.pub" || rm -f "$DIR/secrets/ssh_key.pub"
  local env_tmp
  env_tmp="$(mktemp "$DIR/.env.handover.XXXXXX")"
  chmod 600 "$env_tmp"
  ssh_remote "cat '$remote_workdir/.env'" >"$env_tmp" || { rm -f "$env_tmp"; die "cannot read $remote_workdir/.env on $REMOTE"; }
  [[ ! -f "$DIR/.env" ]] || cp -p "$DIR/.env" "$DIR/.env.bak"
  mv "$env_tmp" "$DIR/.env"
  local profiles brain_port
  profiles="$(env_value "$DIR/.env" COMPOSE_PROFILES)"
  [[ ",$profiles," == *,brain,* ]] || profiles="${profiles:+$profiles,}brain"
  brain_port="$(env_value "$DIR/.env" BRAIN_PORT)"
  env_set "$DIR/.env" COMPOSE_PROJECT_NAME "$PROJECT"
  env_set "$DIR/.env" COMPOSE_PROFILES "$profiles"
  env_set "$DIR/.env" SYMPHONY_BRAIN_OBSIDIAN_URL "http://127.0.0.1:${brain_port:-3000}"
  choose_ci_subnet
  [[ -z "$CI_SUBNET" ]] || env_set "$DIR/.env" SYMPHONY_CI_SUBNET "$CI_SUBNET"
  env_set "$DIR/.env" UID "$(id -u)"
  env_set "$DIR/.env" GID "$(id -g)"
  note "Building $LOCAL_IMAGE from $DIR ..."
  local_compose build

  # 2. Only one instance works the board: stop the local one (if any) and the server.
  local_compose stop >&2 || true
  local host i
  host="$(hostname | tr -cd 'A-Za-z0-9._-')"
  note "Stopping on $REMOTE: ${remote_others[*]} (waits for running agents, up to 120 s) ..."
  # Until the local instance runs, a failure gives the board back to the server (started in reverse stop order).
  for ((i = ${#remote_others[@]} - 1; i >= 0; i--)); do
    [[ " ${running[*]} " != *" ${remote_others[i]} "* ]] || rollback_remote+=("${remote_others[i]}")
  done
  ssh_remote "printf '%s\n' 'handed over to $host at $stamp' ${rollback_remote[*]} > ~/$MARKER && docker stop ${remote_others[*]}" >&2

  # 3. Volumes: create them (Compose labels), back them up, then copy the vault and settings and merge the logs.
  # --force-recreate: a stopped container keeps the ID of the network it was created on; once Compose has recreated
  # that network (another subnet, docker network prune), up -d fails with "network <id> not found". The volumes stay.
  local_compose create --force-recreate --remove-orphans >&2
  local owner kind hint=
  ! $backup || hint=" (backups in $BACKUPS)"
  owner="$(image_owner local_sh "$LOCAL_IMAGE")"
  [[ "$owner" =~ ^[0-9]+:[0-9]+$ ]] || die "cannot read the user of $LOCAL_IMAGE"
  if $backup; then
    mkdir -p "$BACKUPS"
    for kind in brain obsidian-config state watchdog-state; do
      local_volume_exists "$kind" || continue
      note "Backing up $(local_volume "$kind") to $BACKUPS/$stamp-$kind.tgz ..."
      docker run --rm --user 0 -v "$(local_volume "$kind"):/data:ro" --entrypoint tar "$LOCAL_IMAGE" czf - -C /data . >"$BACKUPS/$stamp-$kind.tgz"
    done
  fi
  for kind in brain obsidian-config; do
    [[ -n "${remote_volume[$kind]:-}" ]] || continue
    note "Copying $kind ..."
    ssh_remote "docker run --rm --user 0 -v ${remote_volume[$kind]}:/data:ro --entrypoint tar $remote_image czf - -C /data ." \
      | docker run --rm -i --user 0 -v "$(local_volume "$kind"):/data" --entrypoint sh "$LOCAL_IMAGE" -c "$(replace_snippet "$owner")" \
      || die "copying $kind failed$hint"
  done
  local -A dest=([state]="$STATE_PATH" [watchdog-state]="$WATCHDOG_PATH")
  for kind in state watchdog-state; do
    [[ -n "${remote_volume[$kind]:-}" ]] || continue
    note "Merging the server's $kind into the local one ..."
    ssh_remote "docker run --rm --user 0 -v ${remote_volume[$kind]}:/data:ro --entrypoint tar $remote_image czf - -C /data ." \
      | docker run --rm -i --user 0 -v "$(local_volume "$kind"):${dest[$kind]}" -v "$REPO_ROOT/scripts/merge-history.ts:/merge/merge-history.ts:ro" \
        --entrypoint sh "$LOCAL_IMAGE" -c "$(merge_snippet "${dest[$kind]}" "$owner")" \
      || die "merging $kind failed$hint"
  done

  # 4. Verify and start here.
  local copied
  copied="$(vault_head local_sh "$LOCAL_IMAGE" "$(local_volume brain)")"
  [[ "$copied" == "$remote_head" ]] || die "vault HEAD differs after the copy (server ${remote_head:-none}, local ${copied:-none})"
  if [[ -n "$copied" ]]; then
    docker run --rm --user 0 -v "$(local_volume brain):/data:ro" --entrypoint git "$LOCAL_IMAGE" -c 'safe.directory=*' -C /data fsck --no-dangling --no-progress >&2 \
      || die "git fsck of the copied vault failed"
  fi
  note "Starting Symphony here ..."
  local_compose up -d >&2
  rollback_remote=()

  local port
  port="$(env_value "$DIR/.env" SYMPHONY_PORT)"
  printf '\nDone. Symphony %s runs here, the server is stopped (~/%s on %s).\n' "$tag" "$MARKER" "$REMOTE"
  printf '  Dashboard: http://127.0.0.1:%s/\n  Obsidian:  http://127.0.0.1:%s/ (vault /config/vault)\n' "${port:-4000}" "${brain_port:-3000}"
  printf 'Hand back with: scripts/handover.sh push\n'
}

cmd_push() {
  discover_remote
  local version
  version="$(remote_version)"
  tag="${tag:-v$version}"
  resolve_dir
  [[ -f "$DIR/.env" && -f "$DIR/docker-compose.local.yml" ]] || die "no local setup in $DIR (run pull first, or set SYMPHONY_HANDOVER_DIR / --version)"
  local_image_exists || die "no $LOCAL_IMAGE image here (run pull first)"
  local_volume_exists brain || die "no local volume $(local_volume brain) (run pull first)"

  local name
  for name in "${remote_others[@]}"; do
    [[ "$(remote_running "$name")" != true ]] || die "$name runs on $REMOTE: the server is the active instance, nothing to hand back (run pull first)"
  done
  local marker
  marker="$(ssh_remote "cat ~/$MARKER 2>/dev/null" || true)"
  [[ -n "$marker" ]] || note "Warning: no ~/$MARKER on $REMOTE; the server was not stopped by a pull."

  local remote_head local_head
  remote_head="$(vault_head ssh_remote "$remote_image" "${remote_volume[brain]}")"
  local_head="$(vault_head local_sh "$LOCAL_IMAGE" "$(local_volume brain)")"
  valid_head "$remote_head"
  valid_head "$local_head"
  # The server's vault must not hold commits this machine lacks: the copy would drop them.
  if [[ -n "$remote_head" && "$remote_head" != "$local_head" ]] \
    && ! { [[ -n "$local_head" ]] && vault_contains local_sh "$LOCAL_IMAGE" "$(local_volume brain)" "$remote_head"; }; then
    $force || die "the server's vault has commits this machine lacks (someone worked there after the pull; --force drops them, a backup is kept)"
    note "Warning: --force, the server vault's own commits are replaced (backup on the server)."
  fi

  printf 'Local:        %s, Compose project %s, vault HEAD %s\n' "$DIR" "$PROJECT" "${local_head:0:12}"
  printf 'Server:       %s, %s (v%s), start afterwards: %s\n' "$REMOTE" "$CONTAINER" "$version" "${remote_others[*]}"
  printf 'Transfer:     brain vault, Obsidian settings; logs merged into the server (state, watchdog-state)\n'
  if $backup; then printf 'Backup:       ~/symphony-handover-backup-%s.tgz on the server\n' "$stamp"; else printf 'Backup:       none (--no-backup)\n'; fi

  if $dry_run; then
    printf '\nDry run, nothing changed. Would:\n'
    printf '  1. docker compose -p %s -f docker-compose.local.yml stop (waits for running agents)\n' "$PROJECT"
    printf '  2. back up the server volumes, replace its brain and obsidian-config, merge the local logs into it\n'
    printf '  3. verify the vault HEAD, start on the server: %s; remove ~/%s\n' "${remote_others[*]}" "$MARKER"
    return 0
  fi
  confirm 'Stop Symphony here and hand it back to the server?'

  # 1. Stop here; a failure before the server runs again gives the board back to this machine.
  note "Stopping Symphony here (waits for running agents, up to 120 s) ..."
  rollback_local=true
  local_compose stop >&2

  # 2. Back up the server, copy the vault and settings, merge the logs.
  local kind mounts=() remote_owner hint=
  ! $backup || hint=" (backup: ~/symphony-handover-backup-$stamp.tgz on the server)"
  remote_owner="$(image_owner ssh_remote "$remote_image")"
  [[ "$remote_owner" =~ ^[0-9]+:[0-9]+$ ]] || die "cannot read the user of $remote_image on $REMOTE"
  if $backup; then
    for kind in "${!remote_volume[@]}"; do mounts+=("-v ${remote_volume[$kind]}:/backup/$kind:ro"); done
    note "Backing up the server volumes to ~/symphony-handover-backup-$stamp.tgz ..."
    ssh_remote "docker run --rm --user 0 ${mounts[*]} --entrypoint tar $remote_image czf - -C /backup . > ~/symphony-handover-backup-$stamp.tgz"
  fi
  for kind in brain obsidian-config; do
    if [[ -z "${remote_volume[$kind]:-}" ]] || ! local_volume_exists "$kind"; then continue; fi
    note "Copying $kind ..."
    docker run --rm --user 0 -v "$(local_volume "$kind"):/data:ro" --entrypoint tar "$LOCAL_IMAGE" czf - -C /data . \
      | ssh_remote "docker run --rm -i --user 0 -v ${remote_volume[$kind]}:/data --entrypoint sh $remote_image -c '$(replace_snippet "$remote_owner")'" \
      || die "copying $kind failed$hint"
  done
  remove_remote_merge=true
  ssh_remote "cat > ~/$REMOTE_MERGE" <"$REPO_ROOT/scripts/merge-history.ts"
  local -A dest=([state]="$STATE_PATH" [watchdog-state]="$WATCHDOG_PATH")
  for kind in state watchdog-state; do
    if [[ -z "${remote_volume[$kind]:-}" ]] || ! local_volume_exists "$kind"; then continue; fi
    note "Merging the local $kind into the server's ..."
    docker run --rm --user 0 -v "$(local_volume "$kind"):/data:ro" --entrypoint tar "$LOCAL_IMAGE" czf - -C /data . \
      | ssh_remote "docker run --rm -i --user 0 -v ${remote_volume[$kind]}:${dest[$kind]} -v \$HOME/$REMOTE_MERGE:/merge/merge-history.ts:ro --entrypoint sh $remote_image -c '$(merge_snippet "${dest[$kind]}" "$remote_owner")'" \
      || die "merging $kind failed$hint"
  done

  # 3. Verify and start the server: the containers the pull stopped (its marker), else every Symphony container.
  local copied
  copied="$(vault_head ssh_remote "$remote_image" "${remote_volume[brain]}")"
  [[ "$copied" == "$local_head" ]] || die "vault HEAD differs after the copy (local ${local_head:-none}, server ${copied:-none})$hint"
  local start=() i
  if [[ -n "$marker" ]]; then
    while IFS= read -r name; do
      if [[ "$name" =~ $NAME_RE ]]; then start+=("$name"); fi
    done < <(printf '%s\n' "$marker" | tail -n +2)
  fi
  if ((${#start[@]} == 0)); then
    for ((i = ${#remote_others[@]} - 1; i >= 0; i--)); do start+=("${remote_others[i]}"); done
  fi
  note "Starting on $REMOTE: ${start[*]} ..."
  ssh_remote "docker start ${start[*]} && rm -f ~/$MARKER" >&2 || die "start failed on $REMOTE (run docker start ${start[*]} there)"
  rollback_local=false

  printf '\nDone. Symphony runs on %s again; the local containers are stopped (volumes kept).\n' "$REMOTE"
}

case "$command" in
  pull) cmd_pull ;;
  push) cmd_push ;;
  status) cmd_status ;;
esac
