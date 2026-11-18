# shellcheck shell=bash
# What the installer runs on: Ubuntu version, WSL, architecture, systemd.

OS_ID='' OS_VERSION_ID='' OS_CODENAME='' OS_PRETTY='' ARCH='' IS_WSL=0 HAS_SYSTEMD=0

detect_system() {
  local release="${SYMPHONY_INSTALL_OS_RELEASE:-/etc/os-release}"
  if [[ -r "$release" ]]; then
    OS_ID="$(_os_release_value "$release" ID)"
    OS_VERSION_ID="$(_os_release_value "$release" VERSION_ID)"
    OS_CODENAME="$(_os_release_value "$release" UBUNTU_CODENAME)"
    [[ -n "$OS_CODENAME" ]] || OS_CODENAME="$(_os_release_value "$release" VERSION_CODENAME)"
    OS_PRETTY="$(_os_release_value "$release" PRETTY_NAME)"
  fi
  if command -v dpkg >/dev/null 2>&1; then
    ARCH="$(dpkg --print-architecture 2>/dev/null)"
  else
    ARCH="$(uname -m)"
  fi
  IS_WSL=0
  if [[ -n "${WSL_DISTRO_NAME:-}" ]] || grep -qi microsoft /proc/version 2>/dev/null; then IS_WSL=1; fi
  HAS_SYSTEMD=0
  [[ -d /run/systemd/system ]] && HAS_SYSTEMD=1
  return 0
}

_os_release_value() {
  local file="$1" key="$2" line value
  line="$(grep -E "^${key}=" "$file" 2>/dev/null | head -n 1)"
  value="${line#*=}"
  value="${value#\"}"
  value="${value%\"}"
  printf '%s' "$value"
}

is_ubuntu() { [[ "$OS_ID" == ubuntu ]]; }

print_system() {
  local wsl='' init='ohne systemd'
  ((IS_WSL)) && wsl=', WSL2'
  ((HAS_SYSTEMD)) && init='systemd'
  info "System: ${OS_PRETTY:-unbekannt} (${ARCH}${wsl}, ${init})"
  if ! is_ubuntu; then
    warn "Der Installer ist für Ubuntu gebaut. Prüfungen laufen, Installationen per apt evtl. nicht."
  elif [[ "$OS_VERSION_ID" != 22.04 && "$OS_VERSION_ID" != 24.04 && "$OS_VERSION_ID" != 26.04 ]]; then
    warn "Getestet mit Ubuntu 22.04, 24.04 und 26.04 – $OS_VERSION_ID sollte meist auch gehen."
  fi
}
