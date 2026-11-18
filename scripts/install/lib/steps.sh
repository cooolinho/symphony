# shellcheck shell=bash
# The steps of the installer, the guided setup (wizard), the main menu and the help text.

MODE="${MODE:-}"
SUMMARY_DONE=()
SUMMARY_SKIPPED=()
REPO_PATTERN='^[A-Za-z0-9-]+/[A-Za-z0-9._-]+([[:space:]]*,[[:space:]]*[A-Za-z0-9-]+/[A-Za-z0-9._-]+)*$'

mode_label() {
  case "$1" in
    native) printf 'Nativ (npm start)' ;;
    docker-local) printf 'Docker lokal (docker-compose.local.yml)' ;;
    docker-server) printf 'Docker-Server hinter Traefik (docker-compose.yml)' ;;
    *) printf 'nicht gewählt' ;;
  esac
}

is_docker_mode() { [[ "$MODE" == docker-local || "$MODE" == docker-server ]]; }

done_step() { SUMMARY_DONE+=("$1"); }
skipped_step() { SUMMARY_SKIPPED+=("$1"); }

step_mode() {
  say "Wie soll Symphony laufen?"
  say "  ${C_DIM}Nativ: direkt mit Node.js auf diesem Rechner, Dashboard auf 127.0.0.1.${C_RESET}"
  say "  ${C_DIM}Docker lokal: dasselbe Image wie auf dem Server, ohne Traefik, Dashboard auf 127.0.0.1.${C_RESET}"
  say "  ${C_DIM}Docker-Server: Dauerbetrieb hinter einem vorhandenen Traefik mit HTTPS und Login.${C_RESET}"
  choose "Betriebsart" "$(mode_label native)" "$(mode_label docker-local)" "$(mode_label docker-server)"
  case "$CHOICE" in
    1) MODE=native ;;
    2) MODE=docker-local ;;
    3) MODE=docker-server ;;
  esac
  if is_docker_mode && [[ "$ENV_FILE" != "$SYMPHONY_DIR/.env" ]]; then
    warn "Docker Compose liest immer $SYMPHONY_DIR/.env – der Installer schreibt deshalb dorthin."
    ENV_FILE="$SYMPHONY_DIR/.env"
    env_load "$ENV_FILE"
  fi
  ok "Betriebsart: $(mode_label "$MODE")"
}

ensure_mode() { [[ -n "$MODE" ]] || step_mode; }

# step_mode_keep: keeps a mode from --mode after a confirmation, otherwise asks.
step_mode_keep() {
  if [[ -n "$MODE" ]]; then
    info "Gewählte Betriebsart: $(mode_label "$MODE")"
    confirm "Beibehalten?" j && return 0
  fi
  step_mode
}

step_env_core() {
  ensure_mode
  info "Werte in [Klammern] sind Vorgaben – Enter übernimmt sie."
  ask_required "Repository/Repositories, an denen Symphony arbeitet (owner/name, kommagetrennt)" "$(env_get GITHUB_REPOSITORY)" "$REPO_PATTERN" "Format: owner/name, mehrere durch Komma getrennt."
  env_set GITHUB_REPOSITORY "$ANSWER"
  local repo_owner="${ANSWER%%/*}"

  say "Das GitHub-Project-Board: Nummer aus der URL, z. B. 10 aus https://github.com/users/<du>/projects/10 (die ganze URL geht auch)."
  say "  ${C_DIM}Noch kein Board? Profil → Projects → New project → Vorlage »Kanban«. Fehlende Spalten ergänzt Menüpunkt 7.${C_RESET}"
  while :; do
    ask_required "Board-Nummer oder Board-URL" "$(env_get GITHUB_PROJECT_NUMBER)"
    github_parse_project "$ANSWER" && break
    warn "Bitte eine Zahl oder eine URL wie https://github.com/orgs/<org>/projects/<nummer> eingeben."
  done
  env_set GITHUB_PROJECT_NUMBER "$ANSWER"
  if [[ -n "$PROJECT_OWNER" ]]; then
    env_unset GITHUB_PROJECT_OWNER
  else
    local owner
    owner="$(env_get GITHUB_PROJECT_OWNER)"
    ask "Owner des Boards (User oder Organisation)" "${owner:-$repo_owner}"
    if [[ "$ANSWER" == "$repo_owner" || -z "$ANSWER" ]]; then env_unset GITHUB_PROJECT_OWNER; else env_set GITHUB_PROJECT_OWNER "$ANSWER"; fi
  fi

  local model
  model="$(env_get CLAUDE_MODEL)"
  local options=("opus – stark bei offenen Aufgaben (empfohlen)" "sonnet – günstiger für Alltagsaufgaben" "fable – für komplexe, riskante Arbeit" "haiku – kleine, klar umrissene Änderungen" "Claude-Code-Standard (leer lassen)")
  [[ -n "$model" && ! "$model" =~ ^(opus|sonnet|fable|haiku)$ ]] && options+=("$model behalten")
  say "Standardmodell der Entwickler (ein Label »Model: …« am Issue überschreibt es):"
  choose "CLAUDE_MODEL" "${options[@]}"
  case "$CHOICE_LABEL" in
    opus*) env_set CLAUDE_MODEL opus ;;
    sonnet*) env_set CLAUDE_MODEL sonnet ;;
    fable*) env_set CLAUDE_MODEL fable ;;
    haiku*) env_set CLAUDE_MODEL haiku ;;
    Claude-Code*) env_unset CLAUDE_MODEL ;;
  esac

  ask "Integrations-Branch für Pull Requests, z. B. develop (leer = Default-Branch des Repositorys)" "$(env_get SYMPHONY_BASE_BRANCH)"
  env_set SYMPHONY_BASE_BRANCH "$ANSWER"
  if [[ -n "$ANSWER" ]]; then
    local merge_default=n
    [[ "$(env_get SYMPHONY_AUTO_MERGE)" == true ]] && merge_default=j
    if confirm "Pull Requests nach bestandenem Review und grünen Checks automatisch nach $ANSWER mergen (SYMPHONY_AUTO_MERGE)?" "$merge_default"; then
      env_set SYMPHONY_AUTO_MERGE true
    else
      env_unset SYMPHONY_AUTO_MERGE
    fi
  else
    env_unset SYMPHONY_AUTO_MERGE
  fi

  local agents
  agents="$(env_get SYMPHONY_MAX_CONCURRENT_AGENTS)"
  ask_required "Wie viele Agenten dürfen gleichzeitig laufen? (je ca. 1 CPU und 2 GB RAM)" "${agents:-3}" '^[0-9]+$' "Bitte eine Zahl eingeben."
  if [[ "$ANSWER" == 3 ]]; then env_unset SYMPHONY_MAX_CONCURRENT_AGENTS; else env_set SYMPHONY_MAX_CONCURRENT_AGENTS "$ANSWER"; fi

  local port
  port="$(env_get SYMPHONY_PORT)"
  ask_required "Port des Dashboards" "${port:-4000}" '^[0-9]+$' "Bitte eine Portnummer eingeben."
  if is_docker_mode && [[ "$ANSWER" == 4000 ]]; then env_unset SYMPHONY_PORT; else env_set SYMPHONY_PORT "$ANSWER"; fi
}

step_github() {
  ensure_mode
  headline "GitHub-Token"
  step_github_token || return 1
  headline "SSH-Zugang zu GitHub"
  if is_docker_mode; then step_ssh_docker; else step_ssh_native; fi
}

# step_save_env: preview, confirmation, backup, write.
step_save_env() {
  if ((ENV_DIRTY == 0)) && [[ -f "$ENV_FILE" ]]; then
    info "$ENV_FILE ist aktuell – nichts zu speichern."
    return 0
  fi
  say "So sieht die neue $(basename "$ENV_FILE") aus (Secrets maskiert):"
  env_render mask | sed "s/^/    │ /"
  if is_dry_run; then
    info "[Simulation] $ENV_FILE wird nicht geschrieben."
    ENV_DIRTY=0
    return 0
  fi
  if confirm "Nach $ENV_FILE speichern?" j; then
    env_write "$ENV_FILE"
  else
    warn "Nicht gespeichert – die Änderungen gelten nur bis zum Ende des Installers."
    return 1
  fi
}

# Saves pending changes before a step that reads the .env from disk.
_save_pending() {
  ((ENV_DIRTY)) || return 0
  info "Es gibt ungespeicherte Änderungen an der .env."
  step_save_env
}

step_npm_install() {
  if ! command -v npm >/dev/null 2>&1; then
    is_dry_run || {
      err "npm fehlt (Menüpunkt 3)."
      return 1
    }
  fi
  if [[ -d "$SYMPHONY_DIR/node_modules" ]] && ! confirm "node_modules gibt es schon. Trotzdem npm install ausführen?" n; then return 0; fi
  (cd "$SYMPHONY_DIR" && run npm install --no-audit --no-fund)
}

_host_has_node() {
  req_check node
  [[ "$REQ_STATUS" == ok ]]
}

step_repo_init() {
  ensure_mode
  _save_pending || return 1
  say "repo-init richtet ein: Standard-Labels (Model/Effort/Befehle), fehlende Board-Spalten, ein Issue für Laravel Boost."
  if _host_has_node; then
    [[ -d "$SYMPHONY_DIR/node_modules" ]] || step_npm_install || return 1
    (cd "$SYMPHONY_DIR" && run node repo-init.ts --env-file "$ENV_FILE")
  elif is_docker_mode; then
    info "Kein Node.js $NODE_MIN_MAJOR auf dem Host – repo-init läuft im Container."
    compose_args "$MODE"
    (cd "$SYMPHONY_DIR" && run "${COMPOSE_ARGS[@]}" run --rm --no-deps --entrypoint node symphony /app/repo-init.ts)
  else
    err "Node.js $NODE_MIN_MAJOR fehlt (Menüpunkt 3)."
    return 1
  fi
}

step_symphony_check() {
  ensure_mode
  _save_pending || return 1
  info "Symphony prüft Konfiguration, Token und Board und zeigt, was es starten würde – ohne Agenten zu starten."
  if [[ "$MODE" == native ]]; then
    [[ -d "$SYMPHONY_DIR/node_modules" ]] || step_npm_install || return 1
    (cd "$SYMPHONY_DIR" && run node src/cli.ts WORKFLOW.md --env-file "$ENV_FILE" --dry-run)
  else
    compose_args "$MODE"
    (cd "$SYMPHONY_DIR" && run "${COMPOSE_ARGS[@]}" run --rm symphony --dry-run)
  fi
}

dashboard_url() {
  local port
  port="$(env_get SYMPHONY_PORT)"
  case "$MODE" in
    docker-server)
      if [[ "$(env_get TRAEFIK_TLS)" == false ]]; then printf 'http://%s/' "$(env_get SYMPHONY_DOMAIN)"; else printf 'https://%s/' "$(env_get SYMPHONY_DOMAIN)"; fi
      ;;
    *) printf 'http://127.0.0.1:%s/' "${port:-4000}" ;;
  esac
}

step_start() {
  ensure_mode
  _save_pending || return 1
  if [[ "$MODE" == native ]]; then
    say "Symphony läuft im Vordergrund; Stopp mit Strg+C. Für den Dauerbetrieb z. B. in tmux oder mit Logdatei:"
    say "  ${C_BOLD}npm start -- --log-file ~/symphony.log${C_RESET}"
    say "Dashboard: $(dashboard_url)"
    if confirm "Symphony jetzt starten?" n; then
      (cd "$SYMPHONY_DIR" && run node src/cli.ts WORKFLOW.md --env-file "$ENV_FILE")
    fi
    return 0
  fi
  compose_args "$MODE"
  if confirm "Container jetzt bauen und starten (${COMPOSE_ARGS[*]} up -d --build)?" j; then
    (cd "$SYMPHONY_DIR" && run "${COMPOSE_ARGS[@]}" up -d --build) || return 1
    ok "Gestartet. Dashboard: $(dashboard_url)"
    say "Logs: ${C_BOLD}${COMPOSE_ARGS[*]} logs -f${C_RESET}   Stopp: ${C_BOLD}${COMPOSE_ARGS[*]} down${C_RESET}"
  fi
}

# _wizard_step "n/total" "Titel" function args…: runs one step; on failure the user decides to retry, skip or quit.
_wizard_step() {
  local number="$1" title="$2"
  shift 2
  while :; do
    step "$number" "$title"
    if "$@"; then
      done_step "$title"
      return 0
    fi
    choose "Der Schritt »$title« ist nicht vollständig. Wie weiter?" "Nochmal versuchen" "Überspringen und später erledigen" "Installer beenden"
    case "$CHOICE" in
      1) continue ;;
      2)
        skipped_step "$title"
        return 0
        ;;
      3) exit 1 ;;
    esac
  done
}

wizard() {
  SUMMARY_DONE=()
  SUMMARY_SKIPPED=()
  local total=12
  headline "Geführtes Setup"
  is_dry_run && info "Simulationsmodus: Der Installer fragt alles ab, zeigt aber nur, was er tun würde."
  _wizard_step "1/$total" "Betriebsart" step_mode_keep
  _wizard_step "2/$total" "Requirements prüfen und installieren" offer_install "$MODE"
  if [[ "$MODE" == native ]]; then
    _wizard_step "3/$total" "Abhängigkeiten installieren (npm install)" step_npm_install
  else
    _wizard_step "3/$total" "Docker-Einstellungen" step_docker_settings "$MODE"
  fi
  _wizard_step "4/$total" "Board, Repositories und Grundeinstellungen" step_env_core
  _wizard_step "5/$total" "GitHub-Token" step_github_token
  _wizard_step "6/$total" "Claude-Zugang" step_claude "$MODE"
  if is_docker_mode; then
    _wizard_step "7/$total" "SSH-Schlüssel für den Container" step_ssh_docker
  else
    _wizard_step "7/$total" "SSH-Zugang zu GitHub" step_ssh_native
  fi
  _wizard_step "8/$total" "Git-Identität der Agenten" step_git_identity "$MODE"
  _wizard_step "9/$total" "Optionale Bausteine" step_optional "$MODE"
  _wizard_step "10/$total" ".env speichern" step_save_env
  _wizard_step "11/$total" "Labels und Board-Spalten (repo-init)" step_repo_init
  _wizard_step "12/$total" "Setup prüfen (Symphony --dry-run)" step_symphony_check
  print_summary
  if ((${#SUMMARY_SKIPPED[@]} == 0)) || confirm "Trotz übersprungener Schritte starten?" n; then
    step_start
  fi
}

print_summary() {
  headline "Zusammenfassung"
  local item
  for item in "${SUMMARY_DONE[@]}"; do ok "$item"; done
  for item in "${SUMMARY_SKIPPED[@]}"; do warn "übersprungen: $item"; done
  say ""
  say "Betriebsart: $(mode_label "$MODE")   .env: $ENV_FILE"
  say "Dashboard:   $(dashboard_url)"
  say "Nächste Schritte: Issue auf dem Board nach »Ready« schieben – der Issue-Analyst übernimmt (docs/usage.md)."
  ((${DOCKER_GROUP_ADDED:-0})) && warn "Neu in der Gruppe docker: einmal ab- und wieder anmelden (WSL: wsl --shutdown)."
  return 0
}

show_help() {
  cat <<EOF

${C_BOLD}Symphony-Installer für Ubuntu (auch WSL2)${C_RESET}

Der Installer führt durch das Setup, prüft die Requirements und schreibt eine schlanke .env.
Jeder Schritt lässt sich einzeln wiederholen; vorhandene Werte sind die Vorgaben.

${C_BOLD}Betriebsarten${C_RESET}
  Nativ           Node.js $NODE_MIN_MAJOR, Claude-Code-Login, eigener SSH-Schlüssel; Dashboard http://127.0.0.1:4000
  Docker lokal    docker-compose.local.yml: OAuth-Token, secrets/ssh_key, Git-Identität; kein Traefik
  Docker-Server   docker-compose.yml: zusätzlich Domain, Traefik-Netzwerk, TLS und Dashboard-Login

${C_BOLD}Menü${C_RESET}
  1  Geführtes Setup – alle Schritte nacheinander
  2  Requirements prüfen – Tabelle: vorhanden, fehlt, veraltet
  3  Fehlende Requirements installieren – Auswahl, sudo-Passwort nur einmal
  4  .env bearbeiten – Board, Repositories, Modell, Branch, Docker/Traefik, optionale Bausteine
  5  GitHub – Token prüfen (Scopes repo + project), SSH-Zugang
  6  Claude – Login, OAuth-Token (claude setup-token) oder API-Key
  7  repo-init – Labels, fehlende Board-Spalten, Laravel-Boost-Issue
  8  Setup prüfen – Symphonys eigener --dry-run, startet keine Agenten
  9  Symphony starten
  m  Betriebsart wechseln    d  Simulationsmodus an/aus    h  Hilfe    q  Beenden

${C_BOLD}Simulationsmodus${C_RESET} (--dry-run oder Taste d)
  Fragt alles ab, installiert und schreibt aber nichts: zeigt die Befehle und die .env mit maskierten Secrets.

${C_BOLD}Optionen${C_RESET}
  --dry-run                 Simulationsmodus
  --mode <art>              native | docker-local | docker-server
  --check                   nur die Requirements prüfen (Exit 0 = alles Pflicht da, 1 = etwas fehlt)
  --wizard                  direkt das geführte Setup starten
  --env-file <pfad>         andere .env (nur Nativ; Docker liest immer ./.env)
  --no-color                ohne Farben
  -h, --help                diese Hilfe

Mehr: docs/install.md, alle Variablen: docs/environment.md
EOF
}

print_status_line() {
  local env_state='fehlt'
  [[ -f "$ENV_FILE" ]] && env_state='vorhanden'
  ((ENV_DIRTY)) && env_state+=', ungespeicherte Änderungen'
  local sim='aus'
  is_dry_run && sim="${C_YELLOW}an${C_RESET}"
  say "${C_DIM}Betriebsart:${C_RESET} $(mode_label "$MODE")   ${C_DIM}Simulation:${C_RESET} $sim   ${C_DIM}.env:${C_RESET} $env_state"
}

_menu_run() {
  "$@" || warn "Schritt nicht abgeschlossen."
}

main_menu() {
  while :; do
    headline "Symphony-Installer"
    print_status_line
    cat <<EOF
  1) Geführtes Setup (alle Schritte nacheinander)
  2) Requirements prüfen
  3) Fehlende Requirements installieren
  4) .env einrichten / bearbeiten
  5) GitHub: Token und SSH-Zugang
  6) Claude: Login oder OAuth-Token
  7) Labels und Board-Spalten einrichten (repo-init)
  8) Setup prüfen (Symphony --dry-run)
  9) Symphony starten
  m) Betriebsart wechseln   d) Simulationsmodus an/aus   h) Hilfe   q) Beenden
EOF
    printf '%s ' "${C_BOLD}?${C_RESET} Auswahl:"
    _read_line
    case "$(trim "${REPLY_LINE,,}")" in
      1) wizard ;;
      2)
        ensure_mode
        check_requirements "$MODE" || true
        ;;
      3)
        ensure_mode
        _menu_run offer_install "$MODE"
        ;;
      4)
        ensure_mode
        _menu_run step_env_core
        is_docker_mode && _menu_run step_docker_settings "$MODE"
        is_docker_mode && _menu_run step_git_identity "$MODE"
        _menu_run step_optional "$MODE"
        _menu_run step_save_env
        ;;
      5)
        _menu_run step_github
        _menu_run step_save_env
        ;;
      6)
        ensure_mode
        _menu_run step_claude "$MODE"
        _menu_run step_save_env
        ;;
      7) _menu_run step_repo_init ;;
      8) _menu_run step_symphony_check ;;
      9) _menu_run step_start ;;
      m) step_mode ;;
      d)
        if is_dry_run; then DRY_RUN=0; else DRY_RUN=1; fi
        info "Simulationsmodus ist jetzt $(is_dry_run && printf an || printf aus)."
        ;;
      h | '?') show_help ;;
      q | 0)
        if ((ENV_DIRTY)) && ! is_dry_run && confirm "Ungespeicherte Änderungen an der .env speichern?" j; then step_save_env; fi
        say "Tschüss!"
        return 0
        ;;
      '') ;;
      *) warn "Unbekannte Auswahl – h zeigt die Hilfe." ;;
    esac
  done
}
