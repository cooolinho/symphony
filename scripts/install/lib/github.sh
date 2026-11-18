# shellcheck shell=bash
# GitHub: token (gh login or classic token), its scopes, the board reference and SSH access.

GITHUB_API="${SYMPHONY_INSTALL_GITHUB_API:-https://api.github.com}"
TOKEN_SCOPES='' TOKEN_LOGIN='' TOKEN_HTTP=''

# github_check_token token → TOKEN_HTTP, TOKEN_SCOPES, TOKEN_LOGIN. The token goes to curl through a private header
# file, never as a command-line argument (visible in ps).
github_check_token() {
  local token="$1" dir headers body
  dir="$(make_temp_dir)"
  headers="$dir/auth-header"
  body="$dir/user.json"
  (umask 077 && printf 'Authorization: Bearer %s\n' "$token" >"$headers")
  TOKEN_HTTP="$(curl -sS -o "$body" -D "$dir/response-headers" -w '%{http_code}' -H @"$headers" \
    -H 'Accept: application/vnd.github+json' -H 'User-Agent: symphony-install' "$GITHUB_API/user" 2>/dev/null)" || TOKEN_HTTP=000
  rm -f "$headers"
  TOKEN_SCOPES="$(grep -i '^x-oauth-scopes:' "$dir/response-headers" 2>/dev/null | head -n 1 | cut -d: -f2- | tr -d '\r' | xargs)"
  TOKEN_LOGIN=''
  if command -v jq >/dev/null 2>&1; then TOKEN_LOGIN="$(jq -r '.login // empty' "$body" 2>/dev/null)"; fi
  rm -f "$body" "$dir/response-headers"
}

_has_scope() { [[ ", $TOKEN_SCOPES, " == *", $1, "* ]]; }

# github_validate_token token: prints the result; status 0 when the token can read the board and the repositories.
github_validate_token() {
  local token="$1"
  if is_dry_run && [[ -z "$token" ]]; then
    info "[Simulation] Token-Prüfung übersprungen."
    return 0
  fi
  github_check_token "$token"
  case "$TOKEN_HTTP" in
    200) ;;
    401)
      err "GitHub lehnt den Token ab (401): abgelaufen oder falsch kopiert."
      return 1
      ;;
    000)
      err "GitHub ist nicht erreichbar (Netzwerk?)."
      return 1
      ;;
    *)
      err "Unerwartete Antwort von GitHub (HTTP $TOKEN_HTTP)."
      return 1
      ;;
  esac
  if [[ "$token" == github_pat_* ]]; then
    warn "Fine-grained Token erkannt: Projects v2 auf Benutzer-Boards gehen damit nicht zuverlässig. Empfohlen: Classic Token mit repo + project."
    return 0
  fi
  local missing=()
  _has_scope repo || missing+=(repo)
  _has_scope project || missing+=(project)
  if ((${#missing[@]} > 0)); then
    err "Dem Token fehlen Scopes: ${missing[*]} (vorhanden: ${TOKEN_SCOPES:-keine})."
    return 1
  fi
  ok "Token gültig${TOKEN_LOGIN:+ für $TOKEN_LOGIN}, Scopes: $TOKEN_SCOPES"
}

# github_token_from_gh: logs in with gh if needed, adds the project scope and returns the token in ANSWER.
github_token_from_gh() {
  if ! command -v gh >/dev/null 2>&1; then
    err "gh ist nicht installiert (Menüpunkt 3 installiert es)."
    return 1
  fi
  if is_dry_run; then
    run gh auth login -h github.com -p ssh -w
    run gh auth refresh -h github.com -s project
    run gh auth token
    ANSWER=''
    return 0
  fi
  if ! gh auth status -h github.com >/dev/null 2>&1; then
    info "gh ist noch nicht angemeldet – es öffnet sich der Browser (oder du bekommst einen Code für github.com/login/device)."
    run gh auth login -h github.com -p ssh -w || return 1
  fi
  info "Füge den Scope »project« hinzu (Bestätigung im Browser)."
  run gh auth refresh -h github.com -s project || return 1
  ANSWER="$(gh auth token -h github.com 2>/dev/null)"
  [[ -n "$ANSWER" ]] || {
    err "gh hat keinen Token geliefert."
    return 1
  }
}

step_github_token() {
  local current
  current="$(env_get GITHUB_TOKEN)"
  info "GITHUB_TOKEN: $(env_show_value GITHUB_TOKEN)"
  local options=()
  [[ -n "$current" ]] && options+=("Vorhandenen Token behalten (wird geprüft)")
  options+=("Classic Token im Browser erzeugen und hier einfügen (empfohlen für Server)" "Anmeldung der GitHub CLI wiederverwenden (gh auth token)")
  while :; do
    choose "Woher kommt der GitHub-Token?" "${options[@]}"
    local pick="$CHOICE_LABEL" token=''
    case "$pick" in
      Vorhandenen*) token="$current" ;;
      Classic*)
        say ""
        say "  1. Öffne: ${C_BOLD}https://github.com/settings/tokens/new?scopes=repo,project&description=Symphony${C_RESET}"
        say "  2. Ablauf wählen, Scopes ${C_BOLD}repo${C_RESET} und ${C_BOLD}project${C_RESET} sind vorausgewählt → »Generate token«."
        say "  3. Den Token (ghp_…) kopieren und hier einfügen."
        ask_secret "GitHub-Token"
        token="$ANSWER"
        [[ -n "$token" ]] || {
          warn "Kein Token eingegeben."
          continue
        }
        ;;
      Anmeldung*)
        github_token_from_gh || continue
        token="$ANSWER"
        ;;
    esac
    if github_validate_token "$token"; then
      [[ -n "$token" ]] && env_set GITHUB_TOKEN "$token"
      return 0
    fi
    confirm "Einen anderen Token versuchen?" j || return 1
  done
}

# github_parse_project text → PROJECT_NUMBER, PROJECT_OWNER (owner only from a URL).
github_parse_project() {
  local text="$1"
  PROJECT_NUMBER='' PROJECT_OWNER=''
  if [[ "$text" =~ ^https?://[^/]+/(users|orgs)/([^/[:space:]]+)/projects/([0-9]+)/?([?#].*)?$ ]]; then
    PROJECT_OWNER="${BASH_REMATCH[2]}"
    PROJECT_NUMBER="${BASH_REMATCH[3]}"
  elif [[ "$text" =~ ^[0-9]+$ ]] && ((text > 0)); then
    PROJECT_NUMBER="$text"
  else
    return 1
  fi
}

repository_count() {
  local list
  list="$(env_get GITHUB_REPOSITORY)"
  list="${list//,/ }"
  # shellcheck disable=SC2086 # split on purpose
  set -- $list
  printf '%s' "$#"
}

# ── SSH ──

# ssh_test_github [key]: "successfully authenticated" from ssh -T (which exits with 1 even then).
ssh_test_github() {
  local key="${1:-}" args=(-T -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=yes
    -o "UserKnownHostsFile=$SYMPHONY_DIR/docker/ssh_known_hosts")
  [[ -n "$key" ]] && args+=(-i "$key" -o IdentitiesOnly=yes)
  if is_dry_run; then
    run ssh "${args[@]}" git@github.com
    return 0
  fi
  local output
  output="$(ssh "${args[@]}" git@github.com 2>&1)"
  if [[ "$output" == *"successfully authenticated"* ]]; then
    ok "SSH-Zugang zu GitHub funktioniert: ${output%%!*}!"
    return 0
  fi
  warn "SSH zu GitHub klappt noch nicht: $(printf '%s' "$output" | head -n 1)"
  return 1
}

step_ssh_native() {
  if ssh_test_github; then return 0; fi
  local key="$HOME/.ssh/id_ed25519"
  if [[ ! -f "$key.pub" ]]; then
    confirm "Neuen SSH-Schlüssel $key erzeugen?" j || return 1
    info "ssh-keygen fragt nach einer Passphrase. Ohne Passphrase (Enter) kann Symphony unbeaufsichtigt pushen; mit Passphrase brauchst du einen ssh-agent."
    run install -d -m 0700 "$HOME/.ssh" || return 1
    run ssh-keygen -t ed25519 -f "$key" -C "symphony@$(hostname)" || return 1
  fi
  _upload_user_key "$key.pub" || return 1
  ssh_test_github
}

_upload_user_key() {
  local pub="$1"
  if command -v gh >/dev/null 2>&1 && confirm "Öffentlichen Schlüssel mit gh zu deinem GitHub-Konto hinzufügen?" j; then
    info "gh braucht dafür einmalig den Scope admin:public_key (Bestätigung im Browser)."
    run gh auth refresh -h github.com -s admin:public_key && run gh ssh-key add "$pub" --title "symphony@$(hostname)" && return 0
    warn "Hochladen mit gh hat nicht geklappt – bitte manuell."
  fi
  say "Füge diesen öffentlichen Schlüssel unter ${C_BOLD}https://github.com/settings/ssh/new${C_RESET} hinzu:"
  if [[ -f "$pub" ]]; then sed 's/^/    /' "$pub"; else say "    (Simulation: Inhalt von $pub)"; fi
  pause_for_user "Enter, sobald der Schlüssel bei GitHub hinterlegt ist"
}

# Docker: the deploy key ./secrets/ssh_key, mounted as Docker secret.
step_ssh_docker() {
  local key="$SYMPHONY_DIR/secrets/ssh_key"
  if [[ -f "$key" ]]; then
    info "Schlüssel vorhanden: secrets/ssh_key"
  else
    confirm "SSH-Schlüssel secrets/ssh_key für den Container erzeugen?" j || return 1
    run install -d -m 0700 "$SYMPHONY_DIR/secrets" || return 1
    run ssh-keygen -t ed25519 -f "$key" -N '' -C "symphony@$(hostname)" || return 1
    run chmod 400 "$key" || return 1
  fi
  if ssh_test_github "$key"; then return 0; fi
  local count repo
  count="$(repository_count)"
  repo="$(env_get GITHUB_REPOSITORY)"
  repo="${repo%%,*}"
  say ""
  say "Der Container braucht Schreibzugriff per SSH. Zwei Wege (docs/docker.md, Schritt 6):"
  local options=()
  if ((count == 1)) && command -v gh >/dev/null 2>&1; then
    options+=("Deploy-Key mit Schreibrecht für $repo per gh anlegen (empfohlen bei einem Repository)")
  fi
  options+=("Manuell: Deploy-Key (ein Repository) oder Machine-User (mehrere Repositories)" "Später erledigen")
  choose "Wie soll der Schlüssel zu GitHub?" "${options[@]}"
  case "$CHOICE_LABEL" in
    Deploy-Key*)
      run gh repo deploy-key add "$key.pub" --repo "$repo" --allow-write --title "symphony@$(hostname)" || return 1
      ;;
    Manuell*)
      say "Öffentlicher Schlüssel (secrets/ssh_key.pub):"
      if [[ -f "$key.pub" ]]; then sed 's/^/    /' "$key.pub"; else say "    (Simulation: Inhalt von secrets/ssh_key.pub)"; fi
      say "  • Deploy-Key: Repository → Settings → Deploy keys → Add deploy key, »Allow write access« aktivieren."
      say "  • Machine-User: eigener GitHub-User mit Schreibrecht auf die Repositories, Schlüssel unter dessen Settings → SSH keys."
      pause_for_user "Enter, sobald der Schlüssel hinterlegt ist"
      ;;
    *) return 1 ;;
  esac
  ssh_test_github "$key"
}
