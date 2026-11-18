# shellcheck shell=bash
# Installs the requirements: one function per group (see req_group). APT sources are added with their own keyring
# under /etc/apt/keyrings (no "curl | sudo bash"). sudo is asked for once (sudo_init) before the first group.

GROUP_ORDER=(base node claude gh docker docker_access htpasswd php composer)
APT_UPDATED=0
INSTALLED_GROUPS=()
FAILED_GROUPS=()

apt_update() {
  ((APT_UPDATED)) && return 0
  run_sudo apt-get update -q && APT_UPDATED=1
}

apt_install() {
  run_sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y -q "$@"
}

# _add_apt_source name keyring-url keyring-file "deb …": keyring + sources.list.d entry, then apt-get update.
_add_apt_source() {
  local name="$1" key_url="$2" keyring="$3" line="$4" tmp
  tmp="$(make_temp_dir)/$name.key"
  run_sudo install -m 0755 -d /etc/apt/keyrings || return 1
  download "$key_url" "$tmp" || return 1
  if [[ "$keyring" == *.gpg ]] && ! is_dry_run && ! _is_binary_keyring "$tmp"; then
    run_sudo gpg --batch --yes --dearmor -o "$keyring" "$tmp" || return 1
  else
    run_sudo install -m 0644 "$tmp" "$keyring" || return 1
  fi
  run_sudo chmod a+r "$keyring" || return 1
  sudo_write_file "/etc/apt/sources.list.d/$name.list" "$line" || return 1
  APT_UPDATED=0
  apt_update
}

_is_binary_keyring() { ! grep -q 'BEGIN PGP' "$1" 2>/dev/null; }

install_base() {
  apt_update || return 1
  apt_install git curl jq openssh-client gnupg openssl ca-certificates
}

install_node() {
  command -v curl >/dev/null 2>&1 || is_dry_run || install_base || return 1
  _add_apt_source nodesource https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key /etc/apt/keyrings/nodesource.gpg \
    "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MIN_MAJOR}.x nodistro main" || return 1
  apt_install nodejs || return 1
  is_dry_run || hash -r
}

install_claude() {
  local script
  script="$(make_temp_dir)/claude-install.sh"
  download https://claude.ai/install.sh "$script" || return 1
  run bash "$script" || return 1
  if [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
    export PATH="$HOME/.local/bin:$PATH"
    warn "\$HOME/.local/bin war nicht im PATH; für diese Sitzung ergänzt. Dauerhaft: echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.bashrc"
  fi
  is_dry_run || hash -r
}

install_gh() {
  local arch="${ARCH:-amd64}"
  _add_apt_source github-cli https://cli.github.com/packages/githubcli-archive-keyring.gpg /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    "deb [arch=$arch signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" || return 1
  apt_install gh
}

install_docker() {
  if ((IS_WSL)); then
    warn "WSL erkannt: Docker Desktop mit WSL-Integration ist die bequemere Variante (Einstellungen → Resources → WSL integration)."
    confirm "Trotzdem Docker Engine direkt in dieser WSL-Distribution installieren?" n || return 1
  fi
  local arch="${ARCH:-amd64}" codename="${OS_CODENAME:-noble}"
  _add_apt_source docker https://download.docker.com/linux/ubuntu/gpg /etc/apt/keyrings/docker.asc \
    "deb [arch=$arch signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $codename stable" || return 1
  apt_install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin || return 1
  install_docker_access
}

install_docker_access() {
  if ((HAS_SYSTEMD)); then
    run_sudo systemctl enable --now docker || return 1
  else
    run_sudo service docker start || return 1
  fi
  local user="${SUDO_USER:-${USER:-$(id -un)}}"
  if ! id -nG "$user" 2>/dev/null | grep -qw docker; then
    run_sudo usermod -aG docker "$user" || return 1
    DOCKER_GROUP_ADDED=1
    warn "Du bist jetzt in der Gruppe docker. Das gilt erst nach einer neuen Anmeldung:"
    warn "  abmelden/anmelden (WSL: »wsl --shutdown« in Windows) oder »newgrp docker«, dann ./install.sh erneut starten."
  fi
}

install_htpasswd() {
  apt_update || return 1
  apt_install apache2-utils
}

install_php() {
  local version
  ask "PHP-Version (wie in deinen Laravel-Projekten)" "${PHP_VERSION_DEFAULT:-8.4}"
  version="$ANSWER"
  apt_update || return 1
  apt_install software-properties-common || return 1
  run_sudo add-apt-repository -y ppa:ondrej/php || return 1
  APT_UPDATED=0
  apt_update || return 1
  apt_install "php$version-cli" "php$version-mbstring" "php$version-xml" "php$version-curl" "php$version-zip" \
    "php$version-intl" "php$version-bcmath" "php$version-sqlite3" "php$version-gd" unzip
}

install_composer() {
  if ! command -v php >/dev/null 2>&1 && ! is_dry_run; then
    err "Composer braucht PHP – installiere zuerst PHP."
    return 1
  fi
  local dir expected actual
  dir="$(make_temp_dir)"
  download https://composer.github.io/installer.sig "$dir/composer.sig" || return 1
  download https://getcomposer.org/installer "$dir/composer-setup.php" || return 1
  if ! is_dry_run; then
    expected="$(tr -d '[:space:]' <"$dir/composer.sig")"
    actual="$(sha384sum "$dir/composer-setup.php" | cut -d' ' -f1)"
    if [[ -z "$expected" || "$expected" != "$actual" ]]; then
      err "Signatur des Composer-Installers stimmt nicht – Abbruch."
      return 1
    fi
    ok "Signatur des Composer-Installers geprüft."
  fi
  run_sudo php "$dir/composer-setup.php" --quiet --install-dir=/usr/local/bin --filename=composer
}

# install_groups group…: installs the given groups in GROUP_ORDER, carries on after a failure.
install_groups() {
  local wanted=" $* " group
  INSTALLED_GROUPS=()
  FAILED_GROUPS=()
  for group in "${GROUP_ORDER[@]}"; do
    [[ "$wanted" == *" $group "* ]] || continue
    headline "Installiere: $(group_label "$group")"
    if "install_$group"; then
      INSTALLED_GROUPS+=("$group")
      ok "fertig: $group"
    else
      FAILED_GROUPS+=("$group")
      err "fehlgeschlagen oder abgebrochen: $group"
    fi
  done
  ((${#FAILED_GROUPS[@]} == 0))
}

# offer_install mode: checks, lets the user pick the missing groups, installs them and checks again.
offer_install() {
  local mode="$1"
  check_requirements "$mode"
  if ((${#MISSING_GROUPS[@]} == 0)); then
    if ((${#MISSING_REQUIRED[@]} > 0)); then
      warn "Was noch fehlt, kann der Installer nicht selbst einrichten (siehe Hinweise in der Tabelle)."
    else
      ok "Nichts zu installieren."
    fi
    return 0
  fi
  local labels=() group ordered=()
  for group in "${GROUP_ORDER[@]}"; do
    [[ " ${MISSING_GROUPS[*]} " == *" $group "* ]] || continue
    ordered+=("$group")
    labels+=("$(group_label "$group")")
  done
  say "Fehlende Requirements, die der Installer einrichten kann:"
  choose_many "Was soll installiert werden?" "${labels[@]}"
  if ((${#CHOICES[@]} == 0)); then
    info "Nichts ausgewählt – es wird nichts installiert."
    return 0
  fi
  local picked=() n
  for n in "${CHOICES[@]}"; do picked+=("${ordered[$((n - 1))]}"); done
  # Ask for the sudo password once, up front, unless only the Claude Code installer (no sudo) runs.
  if ! is_dry_run && ((EUID != 0)) && [[ " ${picked[*]} " != " claude " ]]; then
    sudo_init || return 1
  fi
  install_groups "${picked[@]}"
  local status=$?
  headline "Erneute Prüfung"
  is_dry_run && info "[Simulation] Es wurde nichts installiert; die Tabelle zeigt den unveränderten Stand."
  check_requirements "$mode"
  return "$status"
}
