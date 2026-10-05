#!/usr/bin/env bash
# Container entrypoint: checks the required variables, installs the SSH key and the git identity,
# then replaces itself with Symphony so node receives SIGTERM/SIGINT directly (via tini).
set -euo pipefail

run_symphony() {
  exec node /app/src/cli.ts /app/WORKFLOW.md "$@"
}

fail() {
  printf 'symphony-entrypoint: %s\n' "$@" >&2
  exit 2
}

# --help and --version need no secrets.
for arg in "$@"; do
  case "$arg" in
    -h | --help | -v | --version) run_symphony "$@" ;;
  esac
done

# Report every missing variable at once, by name only (never print values).
missing=()
for name in GITHUB_TOKEN GITHUB_PROJECT_NUMBER GITHUB_REPOSITORY GIT_USER_NAME GIT_USER_EMAIL; do
  [[ -n "${!name:-}" ]] || missing+=("$name")
done
if [[ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" && -z "${ANTHROPIC_API_KEY:-}" ]]; then
  missing+=("CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY")
fi
if ((${#missing[@]} > 0)); then
  fail "missing required environment variables:" \
    "${missing[@]/#/  - }" \
    "Set them in the .env file passed to the container (see .env.example and docs/docker.md)."
fi

# Copy the SSH key so the bind mount's owner and mode do not matter to ssh.
ssh_key="${SYMPHONY_SSH_KEY:-/run/secrets/ssh_key}"
if [[ ! -f "$ssh_key" || ! -r "$ssh_key" ]]; then
  fail "SSH key not readable: $ssh_key" \
    "Mount the deploy key there or set SYMPHONY_SSH_KEY (see docs/docker.md)."
fi
install -d -m 0700 "$HOME/.ssh"
install -m 0600 "$ssh_key" "$HOME/.ssh/id_symphony"
if [[ -z "${GIT_SSH_COMMAND:-}" ]]; then
  export GIT_SSH_COMMAND="ssh -i $HOME/.ssh/id_symphony -o IdentitiesOnly=yes"
fi

# Agents commit in their workspaces; without an identity every commit fails.
git config --global user.name "$GIT_USER_NAME"
git config --global user.email "$GIT_USER_EMAIL"

run_symphony "$@"
