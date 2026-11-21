# shellcheck shell=bash
# The .env the installer writes: read the existing file (its values become the defaults), change values in memory,
# then write a lean file grouped by topic. Values are quoted so that docker compose and Node's util.parseEnv read them
# unchanged: a value with "$", a space or "#" goes into single quotes (compose takes those literally).

declare -A ENV_VALUES=()
ENV_ORDER=()
ENV_DIRTY=0

# Keys that are secrets: never printed, only masked.
ENV_SECRET_KEYS=" GITHUB_TOKEN GH_TOKEN CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY SYMPHONY_BASIC_AUTH SYMPHONY_MYSQL_PASSWORD SYMPHONY_CI_MYSQL_ROOT_PASSWORD "

# Sections of the written file: "Title|comment|KEY KEY …". Keys not listed here land in a last section.
ENV_SECTIONS=(
  "GitHub|Board (number or URL), repositories (owner/name, comma-separated) and a classic token with the scopes repo and project.|GITHUB_PROJECT_NUMBER GITHUB_PROJECT_OWNER GITHUB_REPOSITORY GITHUB_TOKEN"
  "Claude|Default model and effort (an issue label \"Model: …\" / \"Effort: …\" wins). Token from: claude setup-token|CLAUDE_MODEL CLAUDE_EFFORT CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY"
  "Orchestrator|Dashboard port, agent slots, integration branch and auto-merge.|SYMPHONY_PORT SYMPHONY_HOST SYMPHONY_ALLOW_REMOTE_CONTROL SYMPHONY_MAX_CONCURRENT_AGENTS SYMPHONY_MAX_TURNS SYMPHONY_MAX_CONTINUATIONS SYMPHONY_BASE_BRANCH SYMPHONY_AUTO_MERGE SYMPHONY_LOG_DIR"
  "Laravel|PHP and Composer for Laravel Boost (only if they are not on the PATH).|SYMPHONY_LARAVEL_BOOST SYMPHONY_PHP SYMPHONY_COMPOSER SYMPHONY_LARAVEL_DB"
  "Docker|Compose project, git identity of the agents' commits and build args.|COMPOSE_PROJECT_NAME COMPOSE_PROFILES GIT_USER_NAME GIT_USER_EMAIL UID GID TZ PHP_VERSION WITH_BROWSER WITH_DOCKER_CLI SYMPHONY_SSH_KEY"
  "Traefik|Dashboard behind Traefik (docker-compose.yml). Keep the single quotes around SYMPHONY_BASIC_AUTH.|SYMPHONY_DOMAIN SYMPHONY_BASIC_AUTH SYMPHONY_TRAEFIK_MIDDLEWARES TRAEFIK_NETWORK TRAEFIK_ENTRYPOINT TRAEFIK_TLS TRAEFIK_CERTRESOLVER"
  "CI sidecars|Compose profile ci: Docker-in-Docker and MySQL for the CI gate (docs/docker.md).|SYMPHONY_CI_DOCKER_HOST SYMPHONY_CI_DOCKER_CERT_PATH SYMPHONY_MYSQL_HOST SYMPHONY_MYSQL_PORT SYMPHONY_MYSQL_USER SYMPHONY_MYSQL_PASSWORD SYMPHONY_CI_MYSQL_ROOT_PASSWORD SYMPHONY_CI_SUBNET"
  "Knowledge vault|brain.enabled in WORKFLOW.md; Obsidian with the compose profile brain (docs/brain.md).|SYMPHONY_BRAIN_ENABLED SYMPHONY_BRAIN_OBSIDIAN_URL BRAIN_DOMAIN BRAIN_TRAEFIK_ENTRYPOINT BRAIN_PORT"
  "Watchdog|Compose profile watchdog: diagnoses blocked issues (docs/watchdog.md).|SYMPHONY_WATCHDOG_MODE SYMPHONY_WATCHDOG_MODEL SYMPHONY_WATCHDOG_MAX_BUDGET_USD SYMPHONY_WATCHDOG_MAX_RESUMES"
)

env_reset() {
  ENV_VALUES=()
  ENV_ORDER=()
  ENV_DIRTY=0
}

_env_remember_key() {
  local key="$1" existing
  for existing in "${ENV_ORDER[@]}"; do [[ "$existing" == "$key" ]] && return 0; done
  ENV_ORDER+=("$key")
}

# env_load file: reads KEY=VALUE lines (comments and blank lines are skipped). A missing file is an empty .env.
env_load() {
  local file="$1" line key value
  env_reset
  [[ -f "$file" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="$(trim "$line")"
    [[ -z "$line" || "$line" == \#* ]] && continue
    line="${line#export }"
    [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    if [[ "$value" == \'* ]]; then
      value="${value#\'}"
      value="${value%%\'*}"
    elif [[ "$value" == \"* ]]; then
      value="${value#\"}"
      value="${value%\"*}"
      value="${value//\\\"/\"}"
    else
      value="${value%%[[:space:]]#*}"
      value="$(trim "$value")"
    fi
    ENV_VALUES["$key"]="$value"
    _env_remember_key "$key"
  done <"$file"
  ENV_DIRTY=0
}

env_has() { [[ -v "ENV_VALUES[$1]" ]]; }
env_get() { if env_has "$1"; then printf '%s' "${ENV_VALUES[$1]}"; fi; }

# env_set KEY VALUE: sets the value; an empty VALUE removes the key (use env_set_empty for "set but empty").
env_set() {
  local key="$1" value="${2:-}"
  if [[ -z "$value" ]]; then
    env_unset "$key"
    return 0
  fi
  if ! env_has "$key" || [[ "${ENV_VALUES[$key]}" != "$value" ]]; then ENV_DIRTY=1; fi
  ENV_VALUES["$key"]="$value"
  _env_remember_key "$key"
}

# env_set_empty KEY: keeps the key with an empty value (e.g. TRAEFIK_CERTRESOLVER= for Traefik's default certificate).
env_set_empty() {
  local key="$1"
  if ! env_has "$key" || [[ -n "${ENV_VALUES[$key]}" ]]; then ENV_DIRTY=1; fi
  ENV_VALUES["$key"]=''
  _env_remember_key "$key"
}

env_unset() {
  local key="$1"
  if env_has "$key"; then
    unset "ENV_VALUES[$key]"
    ENV_DIRTY=1
  fi
}

env_is_secret() { [[ "$ENV_SECRET_KEYS" == *" $1 "* ]]; }

# env_quote VALUE: the value as it goes into the file; fails for values that cannot be written safely.
env_quote() {
  local value="$1"
  if [[ "$value" =~ ^[A-Za-z0-9_./:@,+=%-]*$ ]]; then
    printf '%s' "$value"
  elif [[ "$value" != *"'"* && "$value" != *$'\n'* ]]; then
    printf "'%s'" "$value"
  elif [[ "$value" != *'"'* && "$value" != *'$'* && "$value" != *$'\\'* && "$value" != *$'\n'* ]]; then
    printf '"%s"' "$value"
  else
    return 1
  fi
}

# env_render [mask]: the file content; with "mask" the secrets are replaced by a masked note (preview).
env_render() {
  local mask="${1:-}" section title comment keys key written=" " out quoted
  out="# Symphony configuration, written by ./install.sh on $(date '+%Y-%m-%d %H:%M').
# Every variable with its default: docs/environment.md. Variables set in the shell win over this file."
  for section in "${ENV_SECTIONS[@]}"; do
    IFS='|' read -r title comment keys <<<"$section"
    local lines=''
    for key in $keys; do
      env_has "$key" || continue
      written+="$key "
      if [[ "$mask" == mask ]] && env_is_secret "$key"; then
        lines+="$key=<$(mask_secret "${ENV_VALUES[$key]}")>"$'\n'
        continue
      fi
      quoted="$(env_quote "${ENV_VALUES[$key]}")" || {
        err "$key enthält Zeichen, die sich nicht sicher in .env schreiben lassen (\" und ' und \$ zusammen)."
        return 1
      }
      lines+="$key=$quoted"$'\n'
    done
    [[ -n "$lines" ]] && out+=$'\n\n'"# ── $title ──"$'\n'"# $comment"$'\n'"${lines%$'\n'}"
  done
  local rest=''
  for key in "${ENV_ORDER[@]}"; do
    env_has "$key" || continue
    [[ "$written" == *" $key "* ]] && continue
    if [[ "$mask" == mask ]] && env_is_secret "$key"; then
      rest+="$key=<$(mask_secret "${ENV_VALUES[$key]}")>"$'\n'
      continue
    fi
    quoted="$(env_quote "${ENV_VALUES[$key]}")" || {
      err "$key enthält Zeichen, die sich nicht sicher in .env schreiben lassen."
      return 1
    }
    rest+="$key=$quoted"$'\n'
  done
  [[ -n "$rest" ]] && out+=$'\n\n'"# ── Other values (kept from the previous .env) ──"$'\n'"${rest%$'\n'}"
  printf '%s\n' "$out"
}

# env_write file: backup of an existing file, then the new content with mode 600. Simulation: preview only.
env_write() {
  local file="$1" content
  content="$(env_render)" || return 1
  if is_dry_run; then
    info "[Simulation] würde $file schreiben (Secrets maskiert):"
    env_render mask | sed "s/^/    │ /"
    return 0
  fi
  if [[ -f "$file" ]]; then
    local backup
    backup="$file.bak-$(date +%Y%m%d-%H%M%S)"
    cp -p "$file" "$backup" && chmod 600 "$backup"
    info "Sicherung der bisherigen Datei: $backup"
  fi
  local tmp
  tmp="$(umask 077 && mktemp "$file.XXXXXX")" || return 1
  if ! { printf '%s' "$content" >"$tmp" && chmod 600 "$tmp" && mv "$tmp" "$file"; }; then
    rm -f "$tmp"
    err "Konnte $file nicht schreiben."
    return 1
  fi
  ENV_DIRTY=0
  ok "$file geschrieben (Modus 600)."
}

# env_show_value KEY: value for a status line, masked for secrets.
env_show_value() {
  local key="$1"
  if ! env_has "$key"; then
    printf 'nicht gesetzt'
  elif env_is_secret "$key"; then
    mask_secret "${ENV_VALUES[$key]}"
  else
    printf '%s' "${ENV_VALUES[$key]}"
  fi
}
