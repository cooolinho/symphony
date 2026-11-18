# shellcheck shell=bash
# Docker settings: compose file per mode, git identity, UID/GID, Traefik, dashboard login and the optional profiles.

# compose_args mode → COMPOSE_ARGS (docker compose plus -f for the local file).
compose_args() {
  COMPOSE_ARGS=(docker compose)
  [[ "$1" == docker-local ]] && COMPOSE_ARGS+=(-f docker-compose.local.yml)
  return 0
}

step_git_identity() {
  local mode="$1" name email
  name="$(git config --global user.name 2>/dev/null)"
  email="$(git config --global user.email 2>/dev/null)"
  if [[ "$mode" == native ]]; then
    if [[ -n "$name" && -n "$email" ]]; then
      ok "Git-Identität für die Commits der Agenten: $name <$email>"
      confirm "So lassen?" j && return 0
    fi
    ask_required "Name für die Commits der Agenten" "${name:-Symphony}"
    name="$ANSWER"
    ask_required "E-Mail für die Commits" "${email:-symphony@example.com}" '^[^@[:space:]]+@[^@[:space:]]+$' "Bitte eine E-Mail-Adresse eingeben."
    email="$ANSWER"
    run git config --global user.name "$name" && run git config --global user.email "$email"
    return
  fi
  info "Der Container setzt die Git-Identität aus GIT_USER_NAME und GIT_USER_EMAIL (Pflicht)."
  ask_required "GIT_USER_NAME" "$(env_get GIT_USER_NAME)"
  [[ -n "$ANSWER" ]] || ANSWER="${name:-Symphony}"
  env_set GIT_USER_NAME "$ANSWER"
  ask_required "GIT_USER_EMAIL" "$(env_get GIT_USER_EMAIL)" '^[^@[:space:]]+@[^@[:space:]]+$' "Bitte eine E-Mail-Adresse eingeben."
  env_set GIT_USER_EMAIL "$ANSWER"
}

step_docker_settings() {
  local mode="$1" uid gid
  uid="$(id -u)"
  gid="$(id -g)"
  if [[ "$uid" != 1000 || "$gid" != 1000 ]]; then
    info "Dein User hat UID/GID $uid/$gid (Image-Standard 1000/1000) – wird für Volumes und secrets/ssh_key übernommen."
    env_set UID "$uid"
    env_set GID "$gid"
  else
    env_unset UID
    env_unset GID
  fi
  ask "COMPOSE_PROJECT_NAME (Präfix für Container und Volumes; ändern, wenn mehrere Setups auf einem Host laufen)" "$(env_get COMPOSE_PROJECT_NAME)"
  if [[ -n "$ANSWER" && "$ANSWER" != symphony ]]; then env_set COMPOSE_PROJECT_NAME "$ANSWER"; else env_unset COMPOSE_PROJECT_NAME; fi
  [[ "$mode" == docker-server ]] || return 0

  headline "Traefik und Dashboard"
  ask_required "Domain des Dashboards (SYMPHONY_DOMAIN, DNS zeigt auf diesen Server)" "$(env_get SYMPHONY_DOMAIN)" '^[A-Za-z0-9.-]+$' "Nur den Hostnamen, ohne https://"
  env_set SYMPHONY_DOMAIN "$ANSWER"

  local networks=() current
  current="$(env_get TRAEFIK_NETWORK)"
  if command -v docker >/dev/null 2>&1; then
    # Likely candidates first: the current value, then names that look like a proxy network, then the rest.
    local preferred="${current:-traefik}"
    mapfile -t networks < <(docker network ls --format '{{.Name}}' 2>/dev/null | grep -vxE 'bridge|host|none' |
      awk -v p="$preferred" '{ r = ($0 == p) ? 0 : ($0 ~ /traefik|proxy/) ? 1 : 2; print r "\t" $0 }' | sort -k1,1n -k2 | cut -f2)
  fi
  if ((${#networks[@]} > 0)); then
    choose "Externes Netzwerk von Traefik (TRAEFIK_NETWORK)" "${networks[@]}" "Anderer Name"
    if [[ "$CHOICE_LABEL" == "Anderer Name" ]]; then
      ask_required "Netzwerkname" "${current:-traefik}"
    else
      ANSWER="$CHOICE_LABEL"
    fi
  else
    warn "Keine Docker-Netzwerke gefunden – Traefik muss mit einem externen Netzwerk laufen (docs/docker.md)."
    ask_required "Netzwerkname von Traefik" "${current:-traefik}"
  fi
  if [[ "$ANSWER" == traefik ]]; then env_unset TRAEFIK_NETWORK; else env_set TRAEFIK_NETWORK "$ANSWER"; fi

  choose "Wie ist das Dashboard erreichbar?" \
    "HTTPS mit Let's Encrypt (Cert-Resolver in Traefik)" \
    "HTTPS mit Traefiks Default-Zertifikat (z. B. lokale CA/mkcert im LAN)" \
    "Nur HTTP im vertrauenswürdigen LAN (ohne Obsidian)"
  case "$CHOICE" in
    1)
      local entrypoint resolver
      entrypoint="$(env_get TRAEFIK_ENTRYPOINT)"
      resolver="$(env_get TRAEFIK_CERTRESOLVER)"
      ask_required "HTTPS-Entrypoint" "${entrypoint:-websecure}"
      _set_unless_default TRAEFIK_ENTRYPOINT "$ANSWER" websecure
      ask_required "Name des Cert-Resolvers" "${resolver:-letsencrypt}"
      _set_unless_default TRAEFIK_CERTRESOLVER "$ANSWER" letsencrypt
      env_unset TRAEFIK_TLS
      ;;
    2)
      ask_required "HTTPS-Entrypoint" "websecure"
      _set_unless_default TRAEFIK_ENTRYPOINT "$ANSWER" websecure
      env_set_empty TRAEFIK_CERTRESOLVER
      env_unset TRAEFIK_TLS
      ;;
    3)
      warn "Über HTTP laufen Login und Daten unverschlüsselt – nur im vertrauenswürdigen LAN."
      ask_required "HTTP-Entrypoint" "web"
      env_set TRAEFIK_ENTRYPOINT "$ANSWER"
      env_set TRAEFIK_TLS false
      env_unset TRAEFIK_CERTRESOLVER
      ;;
  esac

  step_dashboard_login
}

_set_unless_default() {
  local key="$1" value="$2" default="$3"
  if [[ "$value" == "$default" ]]; then env_unset "$key"; else env_set "$key" "$value"; fi
}

step_dashboard_login() {
  info "Das Dashboard hat keinen eigenen Login – Traefik schützt es (BasicAuth oder eine vorhandene Middleware)."
  local options=()
  env_has SYMPHONY_BASIC_AUTH && options+=("Vorhandenen BasicAuth-Eintrag behalten")
  options+=("BasicAuth mit Benutzer und Passwort erzeugen" "Vorhandene Traefik-Middleware nutzen (z. B. authelia@docker)")
  choose "Login für das Dashboard" "${options[@]}"
  case "$CHOICE_LABEL" in
    Vorhandenen*) return 0 ;;
    BasicAuth*)
      local user password password2 line=''
      ask_required "Benutzername" "admin" '^[A-Za-z0-9._-]+$' "Nur Buchstaben, Ziffern, . _ -"
      user="$ANSWER"
      while :; do
        ask_secret "Passwort"
        password="$ANSWER"
        ask_secret "Passwort wiederholen"
        password2="$ANSWER"
        [[ -n "$password" && "$password" == "$password2" ]] && break
        is_dry_run && break
        warn "Passwörter leer oder verschieden – nochmal."
      done
      if is_dry_run; then
        run htpasswd -niB "$user"
        line="$user:\$2y\$05\$simulation"
      elif command -v htpasswd >/dev/null 2>&1; then
        line="$(printf '%s\n' "$password" | htpasswd -niB "$user" 2>/dev/null | head -n 1)"
      elif command -v docker >/dev/null 2>&1; then
        info "htpasswd fehlt – nutze das Image httpd:2."
        line="$(printf '%s\n' "$password" | docker run --rm -i httpd:2 htpasswd -niB "$user" 2>/dev/null | head -n 1)"
      fi
      if [[ "$line" != "$user:"* ]]; then
        err "Konnte den BasicAuth-Eintrag nicht erzeugen (htpasswd oder Docker fehlt)."
        return 1
      fi
      env_set SYMPHONY_BASIC_AUTH "$line"
      env_unset SYMPHONY_TRAEFIK_MIDDLEWARES
      ok "SYMPHONY_BASIC_AUTH gesetzt (bcrypt, in einfachen Anführungszeichen)."
      ;;
    Vorhandene*)
      ask_required "Middleware(s), kommagetrennt" "$(env_get SYMPHONY_TRAEFIK_MIDDLEWARES)"
      env_set SYMPHONY_TRAEFIK_MIDDLEWARES "$ANSWER"
      ;;
  esac
}

_add_profile() {
  local profile="$1" current
  current="$(env_get COMPOSE_PROFILES)"
  [[ ",$current," == *",$profile,"* ]] && return 0
  env_set COMPOSE_PROFILES "${current:+$current,}$profile"
}

_random_secret() {
  if is_dry_run; then
    printf 'simulation-secret'
  elif command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 24
  else
    head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

step_optional() {
  local mode="$1" options=()
  options+=("Knowledge Vault (Brain): Agenten teilen Wissen in einem Notiz-Vault")
  [[ "$mode" != native ]] && options+=("CI-Sidecars (Profil ci): Docker-in-Docker + MySQL für das CI-Gate" "Blocked-Watchdog (Profil watchdog): diagnostiziert blockierte Issues")
  [[ "$mode" == native ]] && options+=("Laravel: Pfade zu PHP und Composer festlegen (nur wenn nicht im PATH)")
  say "Optionale Bausteine (Details: docs/environment.md):"
  choose_many "Was soll zusätzlich eingerichtet werden?" "${options[@]}"
  local n label
  for n in "${CHOICES[@]}"; do
    label="${options[$((n - 1))]}"
    case "$label" in
      Knowledge*)
        env_set SYMPHONY_BRAIN_ENABLED true
        if [[ "$mode" != native ]] && confirm "Obsidian im Browser dazu starten (Profil brain)?" j; then
          _add_profile brain
          if [[ "$mode" == docker-server ]]; then
            ask_required "Domain für Obsidian (BRAIN_DOMAIN, immer HTTPS)" "$(env_get BRAIN_DOMAIN)" '^[A-Za-z0-9.-]+$' "Nur den Hostnamen"
            env_set BRAIN_DOMAIN "$ANSWER"
            env_set SYMPHONY_BRAIN_OBSIDIAN_URL "https://$ANSWER"
          else
            local brain_port
            brain_port="$(env_get BRAIN_PORT)"
            env_set SYMPHONY_BRAIN_OBSIDIAN_URL "http://127.0.0.1:${brain_port:-3000}"
          fi
        fi
        ok "Knowledge Vault aktiviert."
        ;;
      CI*)
        warn "Der dind-Sidecar läuft privilegiert: nur für Boards, deren Issues du wie Shell-Zugriff auf den Host vertraust."
        confirm "CI-Sidecars wirklich aktivieren?" n || continue
        _add_profile ci
        env_set SYMPHONY_CI_DOCKER_HOST tcp://docker:2376
        env_set SYMPHONY_CI_DOCKER_CERT_PATH /certs/client
        env_set SYMPHONY_MYSQL_HOST symphony-ci-mysql
        env_set SYMPHONY_MYSQL_PORT 3306
        env_set SYMPHONY_MYSQL_USER symphony
        env_has SYMPHONY_MYSQL_PASSWORD || env_set SYMPHONY_MYSQL_PASSWORD "$(_random_secret)"
        env_has SYMPHONY_CI_MYSQL_ROOT_PASSWORD || env_set SYMPHONY_CI_MYSQL_ROOT_PASSWORD "$(_random_secret)"
        ok "CI-Sidecars aktiviert (MySQL-Passwörter zufällig erzeugt)."
        ;;
      Blocked*)
        _add_profile watchdog
        env_set SYMPHONY_WATCHDOG_MODE observe
        ok "Watchdog aktiviert im Modus observe (nur protokollieren; später comment oder act, siehe docs/watchdog.md)."
        ;;
      Laravel*)
        ask "Pfad zu PHP (leer = php aus dem PATH)" "$(env_get SYMPHONY_PHP)"
        env_set SYMPHONY_PHP "$ANSWER"
        ask "Pfad zu Composer (leer = composer aus dem PATH)" "$(env_get SYMPHONY_COMPOSER)"
        env_set SYMPHONY_COMPOSER "$ANSWER"
        ;;
    esac
  done
  return 0
}
