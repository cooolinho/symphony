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

Vulnerabilities in dependencies (for example the Claude Agent SDK) should be reported to the respective project.
