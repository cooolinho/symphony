# shellcheck shell=bash
# Requirements per mode (native, docker-local, docker-server): check them, print a table, offer to install the
# missing ones. Each requirement has a check, a need per mode and an install group from packages.sh.

NODE_MIN_MAJOR=26
REQ_IDS=(bash curl git jq ssh gpg openssl node npm claude gh docker compose docker_access htpasswd traefik_net php composer)
MISSING_GROUPS=()
MISSING_REQUIRED=()

req_label() {
  case "$1" in
    bash) printf 'bash ≥ 4' ;;
    curl) printf 'curl' ;;
    git) printf 'git' ;;
    jq) printf 'jq' ;;
    ssh) printf 'OpenSSH-Client' ;;
    gpg) printf 'gnupg' ;;
    openssl) printf 'openssl' ;;
    node) printf 'Node.js ≥ %s' "$NODE_MIN_MAJOR" ;;
    npm) printf 'npm' ;;
    claude) printf 'Claude Code CLI' ;;
    gh) printf 'GitHub CLI (gh)' ;;
    docker) printf 'Docker Engine' ;;
    compose) printf 'Docker Compose v2' ;;
    docker_access) printf 'Docker-Daemon erreichbar' ;;
    htpasswd) printf 'htpasswd (apache2-utils)' ;;
    traefik_net) printf 'Traefik-Netzwerk' ;;
    php) printf 'PHP + Extensions' ;;
    composer) printf 'Composer' ;;
  esac
}

# req_need id mode → pflicht | empfohlen | optional | (empty = not relevant in this mode)
req_need() {
  local id="$1" mode="$2"
  case "$id" in
    bash | curl | git | jq | ssh) printf 'pflicht' ;;
    gpg) printf 'optional' ;;
    openssl) [[ "$mode" == native ]] && printf 'optional' || printf 'empfohlen' ;;
    node | npm | claude) [[ "$mode" == native ]] && printf 'pflicht' || printf 'optional' ;;
    gh) printf 'empfohlen' ;;
    docker | compose | docker_access) [[ "$mode" == native ]] || printf 'pflicht' ;;
    htpasswd) [[ "$mode" == docker-server ]] && printf 'optional' ;;
    traefik_net) [[ "$mode" == docker-server ]] && printf 'pflicht' ;;
    php | composer) [[ "$mode" == native ]] && printf 'optional' ;;
  esac
  return 0
}

# req_group id → install group (packages.sh: install_<group>); empty when the installer cannot install it.
req_group() {
  case "$1" in
    bash) printf '' ;;
    curl | git | jq | ssh | gpg | openssl) printf 'base' ;;
    node | npm) printf 'node' ;;
    claude) printf 'claude' ;;
    gh) printf 'gh' ;;
    docker | compose) printf 'docker' ;;
    docker_access) printf 'docker_access' ;;
    htpasswd) printf 'htpasswd' ;;
    traefik_net) printf '' ;;
    php) printf 'php' ;;
    composer) printf 'composer' ;;
  esac
}

group_label() {
  case "$1" in
    base) printf 'Basispakete: git, curl, jq, openssh-client, gnupg, openssl, ca-certificates (apt)' ;;
    node) printf 'Node.js %s + npm (NodeSource-APT-Repository)' "$NODE_MIN_MAJOR" ;;
    claude) printf 'Claude Code CLI (offizieller Installer, ohne sudo, nach ~/.local/bin)' ;;
    gh) printf 'GitHub CLI (offizielles APT-Repository von GitHub)' ;;
    docker) printf 'Docker Engine + Compose-Plugin (offizielles Docker-APT-Repository)' ;;
    docker_access) printf 'Docker-Daemon starten und dich zur Gruppe docker hinzufügen' ;;
    htpasswd) printf 'apache2-utils (htpasswd für den Dashboard-Login)' ;;
    php) printf 'PHP mit Laravel-Extensions (ppa:ondrej/php)' ;;
    composer) printf 'Composer (offizieller Installer mit Signaturprüfung)' ;;
  esac
}

_first_line() { head -n 1 | tr -d '\r'; }

# req_check id → REQ_STATUS (ok | missing | old), REQ_VERSION, REQ_NOTE
req_check() {
  local id="$1" version
  REQ_STATUS=missing REQ_VERSION='' REQ_NOTE=''
  case "$id" in
    bash)
      REQ_VERSION="${BASH_VERSION%%(*}"
      if ((BASH_VERSINFO[0] >= 4)); then REQ_STATUS=ok; else REQ_STATUS=old; fi
      ;;
    curl | git | jq | gpg | openssl)
      if command -v "$id" >/dev/null 2>&1; then
        REQ_STATUS=ok
        version="$("$id" --version 2>/dev/null | _first_line)"
        [[ "$id" == openssl ]] && version="$(openssl version 2>/dev/null | _first_line)"
        REQ_VERSION="$(_version_number "$version")"
      fi
      ;;
    ssh)
      if command -v ssh >/dev/null 2>&1 && command -v ssh-keygen >/dev/null 2>&1; then
        REQ_STATUS=ok
        REQ_VERSION="$(ssh -V 2>&1 | _first_line | sed -E 's/^OpenSSH_([^ ,]+).*/\1/')"
      fi
      ;;
    node)
      if command -v node >/dev/null 2>&1; then
        version="$(node --version 2>/dev/null | _first_line)"
        REQ_VERSION="${version#v}"
        local major="${REQ_VERSION%%.*}"
        if [[ "$major" =~ ^[0-9]+$ ]] && ((major >= NODE_MIN_MAJOR)); then REQ_STATUS=ok; else
          REQ_STATUS=old
          REQ_NOTE="mindestens $NODE_MIN_MAJOR nötig"
        fi
      fi
      ;;
    npm | gh | claude)
      if command -v "$id" >/dev/null 2>&1; then
        REQ_STATUS=ok
        REQ_VERSION="$(_version_number "$("$id" --version 2>/dev/null | _first_line)")"
      elif [[ "$id" == claude && -x "$HOME/.local/bin/claude" ]]; then
        REQ_STATUS=ok
        REQ_NOTE="$HOME/.local/bin ist nicht im PATH"
      fi
      ;;
    docker)
      if command -v docker >/dev/null 2>&1; then
        REQ_STATUS=ok
        REQ_VERSION="$(_version_number "$(docker --version 2>/dev/null | _first_line)")"
      fi
      ;;
    compose)
      if command -v docker >/dev/null 2>&1 && version="$(docker compose version --short 2>/dev/null | _first_line)" && [[ -n "$version" ]]; then
        REQ_STATUS=ok
        REQ_VERSION="${version#v}"
      fi
      ;;
    docker_access)
      if ! command -v docker >/dev/null 2>&1; then
        REQ_NOTE='Docker fehlt'
      elif docker info >/dev/null 2>&1; then
        REQ_STATUS=ok
      elif ! id -nG 2>/dev/null | grep -qw docker; then
        REQ_NOTE='nicht in der Gruppe docker oder Daemon gestoppt'
      else
        REQ_NOTE='Daemon läuft nicht (oder neue Anmeldung nötig)'
      fi
      ;;
    htpasswd)
      command -v htpasswd >/dev/null 2>&1 && REQ_STATUS=ok
      [[ "$REQ_STATUS" == ok ]] || REQ_NOTE='sonst über docker run httpd:2'
      ;;
    traefik_net)
      local network
      network="$(env_get TRAEFIK_NETWORK)"
      network="${network:-traefik}"
      REQ_VERSION="$network"
      if command -v docker >/dev/null 2>&1 && docker network inspect "$network" >/dev/null 2>&1; then
        REQ_STATUS=ok
      else
        REQ_NOTE='Traefik einrichten (docs/docker.md) oder TRAEFIK_NETWORK setzen'
      fi
      ;;
    php)
      if command -v php >/dev/null 2>&1; then
        REQ_VERSION="$(php -r 'echo PHP_VERSION;' 2>/dev/null)"
        local missing_ext=() ext
        for ext in mbstring xml curl zip intl bcmath pdo_sqlite gd; do
          php -m 2>/dev/null | grep -qix "$ext" || missing_ext+=("$ext")
        done
        if ((${#missing_ext[@]} == 0)); then REQ_STATUS=ok; else
          REQ_STATUS=old
          REQ_NOTE="Extensions fehlen: ${missing_ext[*]}"
        fi
      fi
      ;;
    composer)
      if command -v composer >/dev/null 2>&1; then
        REQ_STATUS=ok
        REQ_VERSION="$(_version_number "$(composer --version 2>/dev/null | _first_line)")"
      fi
      ;;
  esac
  return 0
}

# _pad text width: text plus spaces up to width characters.
_pad() {
  local text="$1" width="$2"
  local fill=$((width - ${#text}))
  ((fill < 0)) && fill=0
  printf '%s%*s' "$text" "$fill" ''
}

_version_number() {
  local match
  match="$(grep -oE '[0-9]+(\.[0-9]+)+' <<<"$1" | head -n 1)"
  printf '%s' "$match"
}

# check_requirements mode: prints the table; fills MISSING_GROUPS (installable) and MISSING_REQUIRED (labels).
# Status 1 if a required one is missing.
check_requirements() {
  local mode="$1" id need group status_text
  MISSING_GROUPS=()
  MISSING_REQUIRED=()
  printf '\n  %s %s %s %s\n' "$(_pad Requirement 28)" "$(_pad Status 16)" "$(_pad Version 12)" 'benötigt'
  printf '  %s\n' "──────────────────────────────────────────────────────────────────────────"
  for id in "${REQ_IDS[@]}"; do
    need="$(req_need "$id" "$mode")"
    [[ -n "$need" ]] || continue
    req_check "$id"
    case "$REQ_STATUS" in
      ok) status_text="${C_GREEN}✔ vorhanden${C_RESET}" ;;
      old) status_text="${C_YELLOW}▲ veraltet${C_RESET}" ;;
      *)
        if [[ "$need" == pflicht ]]; then status_text="${C_RED}✘ fehlt${C_RESET}"; else status_text="${C_YELLOW}○ fehlt${C_RESET}"; fi
        ;;
    esac
    # Pad by visible characters: the color codes and multibyte signs (≥, ✔) take no extra width.
    local visible
    case "$REQ_STATUS" in ok) visible='✔ vorhanden' ;; old) visible='▲ veraltet' ;; *) visible='✘ fehlt' ;; esac
    printf '  %s %s%s %s %s' "$(_pad "$(req_label "$id")" 28)" "$status_text" "$(_pad '' $((16 - ${#visible})))" \
      "$(_pad "${REQ_VERSION:-–}" 12)" "$need"
    [[ -n "$REQ_NOTE" ]] && printf '  %s' "${C_DIM}($REQ_NOTE)${C_RESET}"
    printf '\n'
    if [[ "$REQ_STATUS" != ok ]]; then
      [[ "$need" == pflicht ]] && MISSING_REQUIRED+=("$(req_label "$id")")
      group="$(req_group "$id")"
      if [[ -n "$group" && " ${MISSING_GROUPS[*]} " != *" $group "* ]]; then MISSING_GROUPS+=("$group"); fi
    fi
  done
  printf '\n'
  if ((${#MISSING_REQUIRED[@]} > 0)); then
    warn "Es fehlen Pflicht-Requirements: ${MISSING_REQUIRED[*]}"
    return 1
  fi
  ok "Alle Pflicht-Requirements für »$(mode_label "$mode")« sind vorhanden."
  return 0
}
