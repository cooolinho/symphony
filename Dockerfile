# Symphony as a non-root service with PHP, Composer, git and SSH for Node and Laravel repositories.
# Start: docker run <image> [Symphony options]; the entrypoint checks the required variables first.
FROM node:26-trixie-slim

ARG PHP_VERSION=8.4
ARG UID=1000
ARG GID=1000

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# System tools, then PHP from Ondřej Surý's repository (any PHP_VERSION the Laravel projects need).
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash ca-certificates curl git openssh-client openssl ripgrep tini unzip \
    && curl -fsSLo /tmp/debsuryorg-archive-keyring.deb https://packages.sury.org/debsuryorg-archive-keyring.deb \
    && dpkg -i /tmp/debsuryorg-archive-keyring.deb \
    && rm /tmp/debsuryorg-archive-keyring.deb \
    && . /etc/os-release \
    && echo "deb [signed-by=/usr/share/keyrings/debsuryorg-archive-keyring.gpg] https://packages.sury.org/php/ ${VERSION_CODENAME} main" \
        > /etc/apt/sources.list.d/php.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        "php${PHP_VERSION}-cli" \
        "php${PHP_VERSION}-mbstring" \
        "php${PHP_VERSION}-xml" \
        "php${PHP_VERSION}-curl" \
        "php${PHP_VERSION}-zip" \
        "php${PHP_VERSION}-intl" \
        "php${PHP_VERSION}-bcmath" \
        "php${PHP_VERSION}-sqlite3" \
        "php${PHP_VERSION}-gd" \
    && update-alternatives --set php "/usr/bin/php${PHP_VERSION}" \
    && rm -rf /var/lib/apt/lists/*

COPY --from=composer:2 /usr/bin/composer /usr/local/bin/composer

# GitHub's published host keys: ssh verifies github.com strictly, no host-key scan at build time.
COPY docker/ssh_known_hosts /etc/ssh/ssh_known_hosts

# The node image's user "node" holds UID/GID 1000; replace it with "symphony".
# The volume targets exist up front so empty named volumes take over their owner on first mount.
RUN userdel --remove node \
    && (getent group node >/dev/null && groupdel node || true) \
    && groupadd --gid "${GID}" symphony \
    && useradd --uid "${UID}" --gid "${GID}" --create-home --home-dir /home/symphony --shell /bin/bash symphony \
    && install -d -o symphony -g symphony \
        /home/symphony/symphony-workspaces \
        /home/symphony/.local \
        /home/symphony/.local/state \
        /home/symphony/.local/state/symphony \
        /home/symphony/.claude \
        /home/symphony/.cache \
        /home/symphony/.cache/composer

# Claude Code keeps .claude.json in CLAUDE_CONFIG_DIR as well, so all its state lands in the volume.
ENV CLAUDE_CONFIG_DIR=/home/symphony/.claude \
    COMPOSER_CACHE_DIR=/home/symphony/.cache/composer

# /app belongs to root (COPY and npm ci run as root, umask 022) and is read-only for symphony:
# agents cannot change Symphony itself.
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src/ ./src/
COPY hooks/ ./hooks/
COPY checks/ ./checks/
COPY .claude/ ./.claude/
COPY --chmod=0755 docker/entrypoint.sh ./docker/entrypoint.sh
COPY WORKFLOW.md model-costs.yml ./

USER symphony

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD [ -z "${SYMPHONY_PORT:-}" ] || curl -fsS "http://127.0.0.1:${SYMPHONY_PORT}/api/v1/state" >/dev/null

ENTRYPOINT ["/usr/bin/tini", "--", "/app/docker/entrypoint.sh"]
