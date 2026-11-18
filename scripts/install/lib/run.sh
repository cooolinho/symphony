# shellcheck shell=bash
# Every command that changes the system goes through these wrappers. In the simulation (DRY_RUN=1) they print what they
# would do and change nothing; sudo is never asked for then.

DRY_RUN="${DRY_RUN:-0}"
SUDO_KEEPALIVE_PID=''
SUDO_READY=0

_show_command() {
  local prefix="$1"
  shift
  local quoted
  printf -v quoted '%q ' "$@"
  printf '%s\n' "${C_DIM}${prefix}${quoted% }${C_RESET}"
}

is_dry_run() { [[ "$DRY_RUN" == 1 ]]; }

# run cmd args…: runs the command (shown first); in the simulation only shown.
run() {
  if is_dry_run; then
    _show_command '[Simulation] würde ausführen: ' "$@"
    return 0
  fi
  _show_command '$ ' "$@"
  "$@"
}

# run_sudo cmd args…: like run, with sudo unless the installer runs as root.
run_sudo() {
  if ((EUID == 0)); then
    run "$@"
    return
  fi
  if is_dry_run; then
    _show_command '[Simulation] würde ausführen: sudo ' "$@"
    return 0
  fi
  sudo_init || return 1
  _show_command '$ sudo ' "$@"
  sudo "$@"
}

# sudo_init: asks for the sudo password once and keeps the credentials fresh until the installer exits.
sudo_init() {
  ((EUID == 0)) && return 0
  is_dry_run && return 0
  ((SUDO_READY)) && return 0
  if ! command -v sudo >/dev/null 2>&1; then
    err "sudo ist nicht installiert; starte den Installer als root oder installiere sudo."
    return 1
  fi
  if ! sudo -n true 2>/dev/null; then
    info "Für die Installation braucht der Installer einmalig dein sudo-Passwort."
    sudo -v || {
      err "sudo-Anmeldung fehlgeschlagen."
      return 1
    }
  fi
  SUDO_READY=1
  # Keep-alive: refresh the timestamp until the installer's process is gone.
  (
    while kill -0 "$$" 2>/dev/null; do
      sudo -n true 2>/dev/null || exit 0
      sleep 50
    done
  ) >/dev/null 2>&1 &
  SUDO_KEEPALIVE_PID=$!
}

sudo_cleanup() {
  if [[ -n "$SUDO_KEEPALIVE_PID" ]]; then
    kill "$SUDO_KEEPALIVE_PID" 2>/dev/null || true
    SUDO_KEEPALIVE_PID=''
  fi
}

# sudo_write_file path content [mode]: writes a root-owned file (apt sources, keyrings).
sudo_write_file() {
  local path="$1" content="$2" mode="${3:-0644}"
  if is_dry_run; then
    printf '%s\n' "${C_DIM}[Simulation] würde schreiben: $path${C_RESET}"
    printf '%s\n' "$content" | sed "s/^/${C_DIM}    │ /;s/$/${C_RESET}/"
    return 0
  fi
  _show_command '$ sudo tee ' "$path"
  if ((EUID == 0)); then
    printf '%s\n' "$content" >"$path" && chmod "$mode" "$path"
  else
    sudo_init || return 1
    printf '%s\n' "$content" | sudo tee "$path" >/dev/null && sudo chmod "$mode" "$path"
  fi
}

# download url target: downloads into a file (also in the simulation only shown).
download() {
  run curl -fsSL --retry 3 -o "$2" "$1"
}

# make_temp_dir: private temporary directory, removed on exit.
INSTALL_TMP=''
make_temp_dir() {
  if [[ -z "$INSTALL_TMP" ]]; then
    INSTALL_TMP="$(mktemp -d "${TMPDIR:-/tmp}/symphony-install.XXXXXX")"
    chmod 700 "$INSTALL_TMP"
  fi
  printf '%s' "$INSTALL_TMP"
}

install_cleanup() {
  sudo_cleanup
  if [[ -n "$INSTALL_TMP" && -d "$INSTALL_TMP" ]]; then rm -rf "$INSTALL_TMP"; fi
}
