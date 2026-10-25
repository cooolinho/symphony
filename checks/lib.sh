# shellcheck shell=bash
# Shared helpers of the check scripts (sourced, not run). Exit codes: 0 pass, 1 the code must be fixed (output goes to
# the agent), 2 an environment problem, 78 the check does not apply here (it passes as "skipped").

fix() { echo "$*"; exit 1; }
env_problem() { echo "environment: $*"; exit 2; }
skip() { echo "$*"; exit 78; }

# The working tree is clean and every commit is pushed: a check judges what the pull request contains.
require_clean_and_pushed() {
  command -v git >/dev/null 2>&1 || env_problem "git not found"
  local status unpushed
  status=$(git status --porcelain 2>&1) || env_problem "git status failed: $status"
  if [ -n "$status" ]; then
    echo "working tree is not clean; commit or remove these changes:"
    printf '%s\n' "$status" | head -n 50
    exit 1
  fi
  git fetch -q origin 2>/dev/null || env_problem "git fetch origin failed"
  if ! git rev-parse -q --verify '@{u}' >/dev/null 2>&1; then
    fix "branch has no upstream; push the branch (git push -u origin HEAD)"
  fi
  unpushed=$(git log --oneline '@{u}..HEAD' 2>&1) || env_problem "git log failed: $unpushed"
  if [ -n "$unpushed" ]; then
    echo "unpushed commits; push the branch:"
    printf '%s\n' "$unpushed" | head -n 20
    exit 1
  fi
}

# The branch pull requests go into: SYMPHONY_BASE_BRANCH, else the remote's default branch (origin/HEAD).
base_branch() {
  if [ -n "${SYMPHONY_BASE_BRANCH:-}" ]; then
    printf '%s\n' "$SYMPHONY_BASE_BRANCH"
    return
  fi
  local head
  head=$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null) || {
    git remote set-head origin -a >/dev/null 2>&1
    head=$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null) || env_problem "cannot determine the default branch (origin/HEAD)"
  }
  printf '%s\n' "${head#origin/}"
}
