#!/usr/bin/env bash
# Interactive installer for Symphony on Ubuntu (also WSL2): checks and installs the requirements, asks for the GitHub
# token and the Claude credentials and writes a lean .env. Run ./install.sh --help for the options; docs/install.md
# describes every step.
#
# No "set -e": the installer is interactive, and a failing check must lead to a question, not to an exit. Every step
# reports its own failure.
set -uo pipefail

if [[ -z "${BASH_VERSINFO:-}" ]] || ((BASH_VERSINFO[0] < 4)); then
  printf 'install.sh braucht bash 4 oder neuer.\n' >&2
  exit 1
fi

SYMPHONY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_LIB="$SYMPHONY_DIR/scripts/install/lib"

# shellcheck source=scripts/install/lib/ui.sh
source "$INSTALL_LIB/ui.sh"
# shellcheck source=scripts/install/lib/run.sh
source "$INSTALL_LIB/run.sh"
# shellcheck source=scripts/install/lib/system.sh
source "$INSTALL_LIB/system.sh"
# shellcheck source=scripts/install/lib/envfile.sh
source "$INSTALL_LIB/envfile.sh"
# shellcheck source=scripts/install/lib/requirements.sh
source "$INSTALL_LIB/requirements.sh"
# shellcheck source=scripts/install/lib/packages.sh
source "$INSTALL_LIB/packages.sh"
# shellcheck source=scripts/install/lib/github.sh
source "$INSTALL_LIB/github.sh"
# shellcheck source=scripts/install/lib/claude.sh
source "$INSTALL_LIB/claude.sh"
# shellcheck source=scripts/install/lib/docker.sh
source "$INSTALL_LIB/docker.sh"
# shellcheck source=scripts/install/lib/steps.sh
source "$INSTALL_LIB/steps.sh"

USE_COLOR=1
ENV_FILE="$SYMPHONY_DIR/.env"
CHECK_ONLY=0
START_WIZARD=0
DOCKER_GROUP_ADDED=0

usage_error() {
  printf 'install.sh: %s\nHilfe: ./install.sh --help\n' "$1" >&2
  exit 2
}

parse_args() {
  while (($# > 0)); do
    case "$1" in
      --dry-run) DRY_RUN=1 ;;
      --mode)
        (($# >= 2)) || usage_error "--mode braucht einen Wert"
        MODE="$2"
        shift
        ;;
      --mode=*) MODE="${1#--mode=}" ;;
      --check) CHECK_ONLY=1 ;;
      --wizard) START_WIZARD=1 ;;
      --env-file)
        (($# >= 2)) || usage_error "--env-file braucht einen Pfad"
        ENV_FILE="$2"
        shift
        ;;
      --env-file=*) ENV_FILE="${1#--env-file=}" ;;
      --no-color) USE_COLOR=0 ;;
      -h | --help)
        ui_init_colors
        show_help
        exit 0
        ;;
      *) usage_error "unbekannte Option: $1" ;;
    esac
    shift
  done
  case "$MODE" in
    '' | native | docker-local | docker-server) ;;
    *) usage_error "--mode: native, docker-local oder docker-server (nicht »$MODE«)" ;;
  esac
  [[ "$ENV_FILE" == /* ]] || ENV_FILE="$PWD/$ENV_FILE"
  if [[ "$MODE" == docker-* && "$ENV_FILE" != "$SYMPHONY_DIR/.env" ]]; then
    usage_error "--env-file geht nur mit --mode native: Docker Compose liest immer ./.env"
  fi
}

main() {
  parse_args "$@"
  ui_init_colors
  trap install_cleanup EXIT
  trap 'printf "\n"; exit 130' INT
  cd "$SYMPHONY_DIR" || exit 1
  detect_system
  env_load "$ENV_FILE"

  if ((CHECK_ONLY)); then
    [[ -n "$MODE" ]] || MODE=native
    print_system
    say "Betriebsart: $(mode_label "$MODE")"
    check_requirements "$MODE"
    exit $?
  fi

  say "${C_BOLD}Symphony-Installer${C_RESET} – führt Schritt für Schritt durch das Setup."
  print_system
  is_dry_run && info "Simulationsmodus: Es wird nichts installiert und nichts geschrieben."
  if ((START_WIZARD)); then
    wizard
  else
    main_menu
  fi
}

main "$@"
