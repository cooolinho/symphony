# shellcheck shell=bash
# Claude credentials: the login of the installed Claude Code (native only), an OAuth token from »claude setup-token«
# (CLAUDE_CODE_OAUTH_TOKEN, required in Docker) or an API key (ANTHROPIC_API_KEY).

claude_bin() {
  if command -v claude >/dev/null 2>&1; then
    command -v claude
  elif [[ -x "$HOME/.local/bin/claude" ]]; then
    printf '%s' "$HOME/.local/bin/claude"
  fi
}

claude_has_login() { [[ -s "$HOME/.claude/.credentials.json" ]]; }

_set_oauth_token() {
  local token="$1"
  [[ "$token" == sk-ant-oat* ]] || warn "Der Token beginnt nicht mit sk-ant-oat… – bitte prüfen, ob er vollständig kopiert ist."
  env_set CLAUDE_CODE_OAUTH_TOKEN "$token"
  if env_has ANTHROPIC_API_KEY && confirm "ANTHROPIC_API_KEY ist auch gesetzt (wird dann bevorzugt und kostet API-Guthaben). Entfernen?" j; then
    env_unset ANTHROPIC_API_KEY
  fi
  ok "CLAUDE_CODE_OAUTH_TOKEN gesetzt."
}

_ask_oauth_token() {
  local bin
  bin="$(claude_bin)"
  if [[ -n "$bin" ]] && confirm "»claude setup-token« jetzt hier ausführen? (öffnet den Browser; in WSL den Windows-Browser)" j; then
    info "Nach der Anmeldung zeigt Claude Code einen Token (sk-ant-oat…). Kopiere ihn und füge ihn danach hier ein."
    run "$bin" setup-token || warn "setup-token wurde nicht sauber beendet."
  else
    say "Führe auf einem Rechner ${C_BOLD}mit Browser${C_RESET} aus:  ${C_BOLD}claude setup-token${C_RESET}"
    say "und kopiere den angezeigten Token (sk-ant-oat…)."
  fi
  while :; do
    ask_secret "Claude-OAuth-Token"
    [[ -n "$ANSWER" ]] && break
    is_dry_run && return 0
    warn "Kein Token eingegeben."
    confirm "Nochmal versuchen?" j || return 1
  done
  _set_oauth_token "$ANSWER"
}

_ask_api_key() {
  say "API-Key aus ${C_BOLD}https://console.anthropic.com/settings/keys${C_RESET} (abgerechnet nach Verbrauch, nicht über das Abo)."
  ask_secret "ANTHROPIC_API_KEY"
  if [[ -z "$ANSWER" ]]; then
    is_dry_run && return 0
    warn "Kein Key eingegeben."
    return 1
  fi
  [[ "$ANSWER" == sk-ant-* ]] || warn "Der Key beginnt nicht mit sk-ant-… – bitte prüfen."
  env_set ANTHROPIC_API_KEY "$ANSWER"
  ok "ANTHROPIC_API_KEY gesetzt."
}

step_claude() {
  local mode="$1"
  info "CLAUDE_CODE_OAUTH_TOKEN: $(env_show_value CLAUDE_CODE_OAUTH_TOKEN), ANTHROPIC_API_KEY: $(env_show_value ANTHROPIC_API_KEY)"
  local options=()
  if env_has CLAUDE_CODE_OAUTH_TOKEN || env_has ANTHROPIC_API_KEY; then options+=("Vorhandene Zugangsdaten behalten"); fi
  if [[ "$mode" == native ]]; then
    if claude_has_login; then info "Claude-Code-Login gefunden (~/.claude/.credentials.json)."; fi
    options+=("Login von Claude Code nutzen (claude starten, /login)")
  fi
  options+=("OAuth-Token aus »claude setup-token« (Abo, empfohlen für Docker und Server)" "API-Key (ANTHROPIC_API_KEY)")
  choose "Wie meldet sich Symphony bei Claude an?" "${options[@]}"
  case "$CHOICE_LABEL" in
    Vorhandene*) return 0 ;;
    Login*)
      local bin
      bin="$(claude_bin)"
      if [[ -z "$bin" ]]; then
        err "Claude Code ist nicht installiert (Menüpunkt 3)."
        return 1
      fi
      if claude_has_login && ! confirm "Es gibt schon einen Login. Trotzdem neu anmelden?" n; then return 0; fi
      info "Claude Code startet. Gib dort ${C_BOLD}/login${C_RESET} ein, melde dich im Browser an und beende danach mit ${C_BOLD}/exit${C_RESET}."
      pause_for_user "Enter startet claude"
      run "$bin" || true
      if is_dry_run || claude_has_login; then
        ok "Claude-Code-Login vorhanden."
      else
        warn "Kein Login gefunden – du kannst den Schritt später wiederholen."
        return 1
      fi
      ;;
    OAuth*) _ask_oauth_token ;;
    API*) _ask_api_key ;;
  esac
}
