# Security Policy

## Supported versions

Symphony is under active development. Security fixes are made on the latest `main` branch only.

## Reporting a vulnerability

Please **do not** report security vulnerabilities in public issues, discussions or pull requests.

Use GitHub's private vulnerability reporting instead:
[Report a vulnerability](https://github.com/cooolinho/symphony/security/advisories/new).

Please include:

- a description of the problem and its impact,
- steps or a proof of concept to reproduce it,
- the affected version or commit, and your environment (Node.js version, Docker or not).

You can expect an acknowledgement within a few days. We will keep you informed about the progress, and credit you in
the fix unless you prefer to stay anonymous.

## Scope and hardening

Symphony runs coding agents unattended, so its security model matters. Read the
[Security section in docs/usage.md](docs/usage.md#security) and [docs/agent-claude.md](docs/agent-claude.md) before you
run it. In short:

- Issue texts are untrusted input. Only use boards whose issues you trust.
- The agent runs with the permissions of its Linux user. Use the Claude Code sandbox, a separate user, a container
  ([docs/docker.md](docs/docker.md)) or a VM for more isolation.
- The dashboard has no login of its own. Put it behind a reverse proxy with authentication if it is not bound to
  loopback.
- Never commit your `.env` or share GitHub or Anthropic tokens.
- The optional compose profile `ci` ([docs/docker.md](docs/docker.md#ci-sidecars-profile-ci)) adds a **privileged
  Docker-in-Docker** daemon. Whoever can reach it is effectively root on the host. Agents and checks run as the same
  user (UID 1000) in the `symphony` container and can both read the daemon's client certificates. That `DOCKER_HOST`
  is kept out of the shared environment prevents accidents; it is not a security boundary.

Vulnerabilities in dependencies (for example the Claude Agent SDK) should be reported to the respective project.

### Stage-result markers

Stage results are stored as hidden `<!-- symphony:result:v1 … -->` markers in issue comments. Two rules keep them from
being forged:

- `add_comment` and `create_sub_issue` reject any text containing `<!-- symphony:` (`invalid_argument`), so an agent
  cannot write a marker.
- Markers only count in comments authored by the account the token belongs to (`viewerLogin()`); markers from every
  other author are ignored and logged.

Run Symphony with its **own account** (a machine user or a GitHub App token), not a personal token. With a personal
token, a human comment from the same account could carry a marker and would be trusted; the author filter then only
protects against agents and other accounts.
