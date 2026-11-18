# Installer (`./install.sh`)

`install.sh` sets up Symphony on **Ubuntu** (22.04, 24.04, 26.04; also under **WSL2**) step by step: it checks the
requirements and lists what is there and what is missing, installs the missing ones you pick (asking for the sudo
password once), waits for your input where you have to do something in the browser (GitHub token, Claude OAuth token,
SSH key) and writes a lean `.env` with exactly the values you chose. The installer talks German; this page describes
what it does.

```bash
git clone git@github.com:cooolinho/symphony.git && cd symphony
./install.sh            # interactive menu
./install.sh --wizard   # straight into the guided setup
./install.sh --dry-run  # simulation: asks everything, changes nothing
./install.sh --help
```

It does the same steps as [Getting Started](getting-started.md) (native) and [Docker](docker.md); those pages stay
the reference for doing it by hand and for troubleshooting.

## Modes

| Mode | Runs | The installer sets up |
|---|---|---|
| **Native** (`--mode native`) | `npm start` on this machine, dashboard on `http://127.0.0.1:<port>/` | Node.js 26, `npm install`, Claude Code login or token, your SSH key on GitHub, your git identity |
| **Docker local** (`--mode docker-local`) | `docker-compose.local.yml`, the production image without Traefik, dashboard on `127.0.0.1` | Docker, `CLAUDE_CODE_OAUTH_TOKEN`, `secrets/ssh_key` as deploy key, `GIT_USER_NAME`/`GIT_USER_EMAIL`, UID/GID |
| **Docker server** (`--mode docker-server`) | `docker-compose.yml` behind an existing Traefik | additionally `SYMPHONY_DOMAIN`, the Traefik network, TLS variant (Let's Encrypt, default certificate, HTTP-only LAN) and the dashboard login (BasicAuth via `htpasswd` or a middleware) |

Traefik itself is not installed; the installer checks that its network exists.

## Menu

```
 1) Geführtes Setup (alle Schritte nacheinander)
 2) Requirements prüfen
 3) Fehlende Requirements installieren
 4) .env einrichten / bearbeiten
 5) GitHub: Token und SSH-Zugang
 6) Claude: Login oder OAuth-Token
 7) Labels und Board-Spalten einrichten (repo-init)
 8) Setup prüfen (Symphony --dry-run)
 9) Symphony starten
 m) Betriebsart wechseln   d) Simulationsmodus an/aus   h) Hilfe   q) Beenden
```

Every item can be run on its own and again later: existing values from `.env` are the defaults (secrets are shown
masked, e.g. `gesetzt (…abcd)`). The status line on top shows the mode, the simulation switch and whether `.env` has
unsaved changes.

## The guided setup

1. **Mode** – native, Docker local or Docker server; the system (Ubuntu version, WSL, systemd) is detected.
2. **Requirements** – a table with status (`✔ vorhanden`, `✘ fehlt`, `○ fehlt` for optional ones, `▲ veraltet`),
   version and whether the mode needs it; you pick what to install (see below), then the table is checked again.
3. **`npm install`** (native) or **Docker settings** – UID/GID, `COMPOSE_PROJECT_NAME`; for the server domain,
   Traefik network, TLS and dashboard login.
4. **Board, repositories and basics** – `GITHUB_REPOSITORY`, the board number or URL (`GITHUB_PROJECT_OWNER` only when
   it differs from the repository owner), `CLAUDE_MODEL`, `SYMPHONY_BASE_BRANCH` and `SYMPHONY_AUTO_MERGE`, agent
   slots, dashboard port.
5. **GitHub token** – a classic token: the installer prints the link with the scopes `repo` and `project` preselected
   and waits for you to paste it (hidden input), or it reuses the GitHub CLI login (`gh auth login`,
   `gh auth refresh -s project`, `gh auth token`). It checks the token against the GitHub API (status and
   `x-oauth-scopes`); the token goes to `curl` through a private header file, never on the command line.
6. **Claude** – natively the Claude Code login (`claude`, then `/login`), an OAuth token from `claude setup-token`
   (pasted, hidden) or an API key; Docker needs the token or the key.
7. **SSH** – natively: tests `ssh -T git@github.com`, creates `~/.ssh/id_ed25519` if needed and adds it with
   `gh ssh-key add` or shows it for <https://github.com/settings/ssh/new>. Docker: creates `secrets/ssh_key`, adds it
   as a deploy key with write access (`gh repo deploy-key add --allow-write`, one repository) or explains the machine
   user, then tests it. The tests use GitHub's pinned host keys from `docker/ssh_known_hosts`.
8. **Git identity** – natively your global git identity; Docker `GIT_USER_NAME`/`GIT_USER_EMAIL`.
9. **Optional parts** – knowledge vault (and Obsidian with the profile `brain`), CI sidecars (profile `ci`, random
   MySQL passwords), the blocked watchdog (profile `watchdog`, mode `observe`), PHP/Composer paths.
10. **Save `.env`** – preview with masked secrets, confirmation, a backup `.env.bak-<time>` of the old file, then the
    new file with mode `600`. Keys the installer does not know are kept in a section of their own.
11. **repo-init** – labels, missing board columns and the Laravel Boost issue (see below); in Docker without Node on
    the host it runs inside the container.
12. **Check** – Symphony's own dry run (`node src/cli.ts --dry-run` or `docker compose … run --rm symphony --dry-run`).

At the end a summary lists what is done and what was skipped, and the installer offers to start Symphony
(`npm start` in the foreground, or `docker compose … up -d --build`). A failed step asks whether to retry, skip it or
quit.

## What it installs

| Group | Source |
|---|---|
| Base packages (git, curl, jq, openssh-client, gnupg, openssl, ca-certificates) | Ubuntu (apt) |
| Node.js 26 + npm | NodeSource APT repository (`/etc/apt/keyrings/nodesource.gpg`) |
| Claude Code CLI | official installer `https://claude.ai/install.sh`, as your user (no sudo), into `~/.local/bin` |
| GitHub CLI | GitHub's APT repository (`cli.github.com/packages`) |
| Docker Engine + Compose plugin | Docker's APT repository; starts the daemon and adds you to the group `docker` |
| apache2-utils (`htpasswd`) | Ubuntu (apt); without it the BasicAuth line comes from `docker run httpd:2 htpasswd` |
| PHP with the Laravel extensions | `ppa:ondrej/php`, version of your choice (default 8.4) |
| Composer | official installer, checked against its published SHA-384 signature |

Every APT source gets its own keyring under `/etc/apt/keyrings` and an entry in `/etc/apt/sources.list.d/`; nothing
is piped from `curl` into a root shell.

**sudo:** the installer asks for the password once (`sudo -v`) before the first installation and keeps the credentials
fresh in the background until it exits. As root it runs without sudo; in the simulation it never asks.

**WSL2:** Docker Desktop with WSL integration is the more convenient choice; the installer asks before installing
Docker Engine inside the distribution and starts the daemon with `service` when there is no systemd. After being
added to the group `docker`, log out and in again (in WSL: `wsl --shutdown` in Windows) or run `newgrp docker`, then
start the installer again.

## Board columns (repo-init)

`npm run repo-init` got a task `board`: it reads the `Status` field of the board in `GITHUB_PROJECT_NUMBER` and adds
the columns `WORKFLOW.md` expects (`Backlog`, `Ready`, `Design`, `In progress`, `Testing`, `Documentation`,
`Agent review`, `Security review`, `Blocked`, `In review`, `Done`) after a confirmation. Existing columns keep their id,
color, description and order, so cards keep their column; each missing one is inserted after its predecessor. Run it
alone with:

```bash
npm run repo-init -- --task board
```

The token needs the `project` scope.

## Options

| Option | Meaning |
|---|---|
| `--dry-run` | Simulation: asks everything, installs and writes nothing, shows the commands and the `.env` with masked secrets. Toggle it in the menu with `d`. |
| `--mode native\|docker-local\|docker-server` | Preselects the mode. |
| `--check` | Only the requirements table; exit code 0 when every required one is there, otherwise 1 (default mode: native). |
| `--wizard` | Starts the guided setup instead of the menu. |
| `--env-file <path>` | Another `.env` (native only: docker compose always reads `./.env`). |
| `--no-color` | No colors (also with `NO_COLOR` set or without a terminal). |
| `-h`, `--help` | Help. |

The installer reads its answers from stdin, so it can be driven by piped input as well; answers are echoed (secrets
as `****`) when stdin is not a terminal.

## Files

| Path | Content |
|---|---|
| `install.sh` | Entry point: options, menu, guided setup |
| `scripts/install/lib/ui.sh` | Output and prompts |
| `scripts/install/lib/run.sh` | Command wrappers for the simulation, sudo once with keep-alive |
| `scripts/install/lib/system.sh` | Ubuntu version, WSL, architecture |
| `scripts/install/lib/requirements.sh` | Requirements per mode and the table |
| `scripts/install/lib/packages.sh` | Installation per group |
| `scripts/install/lib/envfile.sh` | Reading, quoting and writing `.env` |
| `scripts/install/lib/github.sh`, `claude.sh`, `docker.sh` | Token, SSH, Claude credentials, Docker and Traefik settings |
| `scripts/install/lib/steps.sh` | Steps, guided setup, menu, help |

## Troubleshooting

| Symptom | Fix |
|---|---|
| `GitHub lehnt den Token ab (401)` | Expired or incompletely copied; create a new classic token with `repo` and `project`. |
| `Dem Token fehlen Scopes: project` | Classic token: tick `project`; gh: `gh auth refresh -s project`. |
| `Docker-Daemon erreichbar ✘` after the installation | The group `docker` applies after a new login (`newgrp docker`; WSL: `wsl --shutdown`). |
| `Traefik-Netzwerk ✘` | Traefik is not running or uses another network; set it in step 3 or see [Docker](docker.md#requirements). |
| `SSH zu GitHub klappt noch nicht` | Key not on GitHub yet, a deploy key without *Allow write access*, or one deploy key for several repositories; see [Docker, step 6](docker.md#6-add-the-public-key-to-github). |
| Symphony's dry run reports `unknown board column` | Menu item 7, task *Board columns*. |

← [Documentation](index.md) · Variables: [environment.md](environment.md) · By hand: [Getting Started](getting-started.md), [Docker](docker.md)
