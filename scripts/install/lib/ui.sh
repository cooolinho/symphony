# shellcheck shell=bash
# Terminal output and prompts of the installer (sourced by install.sh). Every prompt reads one line from stdin, so the
# installer can also be driven by piped answers (tests). End of input stops the installer instead of looping.

C_RESET='' C_BOLD='' C_DIM='' C_RED='' C_GREEN='' C_YELLOW='' C_BLUE='' C_CYAN=''

ui_init_colors() {
  if [[ "${USE_COLOR:-1}" == 1 && -t 1 && -z "${NO_COLOR:-}" ]]; then
    C_RESET=$'\e[0m' C_BOLD=$'\e[1m' C_DIM=$'\e[2m' C_RED=$'\e[31m' C_GREEN=$'\e[32m'
    C_YELLOW=$'\e[33m' C_BLUE=$'\e[34m' C_CYAN=$'\e[36m'
  else
    C_RESET='' C_BOLD='' C_DIM='' C_RED='' C_GREEN='' C_YELLOW='' C_BLUE='' C_CYAN=''
  fi
}

say() { printf '%s\n' "$*"; }
info() { printf '%s\n' "${C_CYAN}ℹ${C_RESET} $*"; }
ok() { printf '%s\n' "${C_GREEN}✔${C_RESET} $*"; }
warn() { printf '%s\n' "${C_YELLOW}⚠${C_RESET} $*"; }
err() { printf '%s\n' "${C_RED}✘${C_RESET} $*" >&2; }
die() {
  err "$*"
  exit 1
}
dim() { printf '%s\n' "${C_DIM}$*${C_RESET}"; }

headline() {
  printf '\n%s\n' "${C_BOLD}${C_BLUE}━━ $* ━━${C_RESET}"
}

# step "3/13" "Titel": heading of one wizard step.
step() {
  printf '\n%s\n' "${C_BOLD}${C_BLUE}[$1]${C_RESET} ${C_BOLD}$2${C_RESET}"
}

# Reads one line into REPLY_LINE; stops the installer once the input has ended. Piped input (no terminal) is echoed
# so that a log reads like the session; "secret" echoes **** instead.
_read_line() {
  local line
  if ! IFS= read -r line; then
    printf '\n'
    err "Eingabe beendet – Installer wird abgebrochen."
    exit 130
  fi
  if [[ ! -t 0 ]]; then
    if [[ "${1:-}" == secret && -n "$line" ]]; then printf '****\n'; else printf '%s\n' "$line"; fi
  fi
  REPLY_LINE="$line"
}

# ask "Frage" "default" → ANSWER (trimmed; Enter takes the default).
ask() {
  local question="$1" default="${2:-}"
  if [[ -n "$default" ]]; then
    printf '%s ' "${C_BOLD}?${C_RESET} $question [${default}]:"
  else
    printf '%s ' "${C_BOLD}?${C_RESET} $question:"
  fi
  _read_line
  ANSWER="$(trim "$REPLY_LINE")"
  [[ -n "$ANSWER" ]] || ANSWER="$default"
}

# ask_required "Frage" "default" ["regex" "Hinweis"] → ANSWER, repeats until it is not empty (and matches).
ask_required() {
  local question="$1" default="${2:-}" pattern="${3:-}" hint="${4:-}"
  while :; do
    ask "$question" "$default"
    if [[ -z "$ANSWER" ]]; then
      warn "Bitte einen Wert eingeben."
    elif [[ -n "$pattern" && ! "$ANSWER" =~ $pattern ]]; then
      warn "${hint:-Ungültiges Format.}"
    else
      return 0
    fi
  done
}

# ask_secret "Frage" → ANSWER; the input is not echoed and never printed.
ask_secret() {
  printf '%s ' "${C_BOLD}?${C_RESET} $1 (Eingabe unsichtbar):"
  local line
  if [[ -t 0 ]]; then
    if ! IFS= read -rs line; then
      printf '\n'
      err "Eingabe beendet – Installer wird abgebrochen."
      exit 130
    fi
    printf '\n'
  else
    _read_line secret
    line="$REPLY_LINE"
  fi
  ANSWER="$(trim "$line")"
}

# confirm "Frage" j|n → status 0 for yes.
confirm() {
  local question="$1" default="${2:-n}" hint
  if [[ "$default" == j ]]; then hint='[J/n]'; else hint='[j/N]'; fi
  while :; do
    printf '%s ' "${C_BOLD}?${C_RESET} $question $hint"
    _read_line
    case "$(trim "${REPLY_LINE,,}")" in
      '') [[ "$default" == j ]] && return 0 || return 1 ;;
      j | ja | y | yes) return 0 ;;
      n | nein | no) return 1 ;;
      *) warn "Bitte mit j oder n antworten." ;;
    esac
  done
}

# choose "Frage" "Option 1" "Option 2" … → CHOICE (1-based), CHOICE_LABEL. Enter picks option 1.
choose() {
  local question="$1"
  shift
  local options=("$@") i
  for i in "${!options[@]}"; do
    printf '  %s) %s\n' "$((i + 1))" "${options[$i]}"
  done
  while :; do
    printf '%s ' "${C_BOLD}?${C_RESET} $question [1]:"
    _read_line
    local answer
    answer="$(trim "$REPLY_LINE")"
    [[ -n "$answer" ]] || answer=1
    if [[ "$answer" =~ ^[0-9]+$ ]] && ((answer >= 1 && answer <= ${#options[@]})); then
      CHOICE="$answer"
      CHOICE_LABEL="${options[$((answer - 1))]}"
      return 0
    fi
    warn "Bitte eine Zahl von 1 bis ${#options[@]} eingeben."
  done
}

# choose_many "Frage" "Option 1" … → CHOICES (array of 1-based numbers). "a" or Enter = all, "-" = none,
# otherwise numbers separated by spaces or commas.
choose_many() {
  local question="$1"
  shift
  local options=("$@") i
  for i in "${!options[@]}"; do
    printf '  %s) %s\n' "$((i + 1))" "${options[$i]}"
  done
  while :; do
    printf '%s ' "${C_BOLD}?${C_RESET} $question (Enter/a = alle, - = keine, z. B. 1 3):"
    _read_line
    local answer valid=1 n
    answer="$(trim "${REPLY_LINE,,}")"
    CHOICES=()
    if [[ -z "$answer" || "$answer" == a || "$answer" == alle ]]; then
      for i in "${!options[@]}"; do CHOICES+=("$((i + 1))"); done
      return 0
    fi
    if [[ "$answer" == - || "$answer" == keine ]]; then
      return 0
    fi
    for n in ${answer//,/ }; do
      if [[ "$n" =~ ^[0-9]+$ ]] && ((n >= 1 && n <= ${#options[@]})); then
        [[ " ${CHOICES[*]} " == *" $n "* ]] || CHOICES+=("$n")
      else
        valid=0
      fi
    done
    if ((valid)) && ((${#CHOICES[@]} > 0)); then return 0; fi
    warn "Bitte Zahlen von 1 bis ${#options[@]} eingeben, getrennt durch Leerzeichen oder Komma."
  done
}

# pause_for_user "Text": waits for Enter, e.g. while the user does something in the browser.
pause_for_user() {
  printf '%s ' "${C_BOLD}⏎${C_RESET} ${1:-Weiter mit Enter}"
  _read_line
}

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

# mask_secret "wert" → "gesetzt (…abcd)" for long values, "gesetzt" for short ones, "nicht gesetzt" for empty.
mask_secret() {
  local value="$1"
  if [[ -z "$value" ]]; then
    printf 'nicht gesetzt'
  elif ((${#value} >= 16)); then
    printf 'gesetzt (…%s)' "${value: -4}"
  else
    printf 'gesetzt'
  fi
}
