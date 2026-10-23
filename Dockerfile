# Symphony as a non-root service with PHP, Composer, pnpm, git, SSH and gitleaks for Node and Laravel repositories.
# Start: docker run <image> [Symphony options]; the entrypoint checks the required variables first.
FROM node:26-trixie-slim

ARG PHP_VERSION=8.4
ARG UID=1000
ARG GID=1000

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# System tools, then PHP from Ondřej Surý's repository (any PHP_VERSION the Laravel projects need).
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash ca-certificates curl git jq openssh-client openssl ripgrep tini unzip \
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

# gitleaks for the secret scan in the projects' pre-commit hooks: pinned release binary, checksums from
# gitleaks_<version>_checksums.txt. The ARGs sit here so a version bump rebuilds only this layer.
ARG GITLEAKS_VERSION=8.30.1
ARG GITLEAKS_SHA256_X64=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
ARG GITLEAKS_SHA256_ARM64=e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080
RUN case "$(dpkg --print-architecture)" in \
        amd64) arch=x64 sha="${GITLEAKS_SHA256_X64}" ;; \
        arm64) arch=arm64 sha="${GITLEAKS_SHA256_ARM64}" ;; \
        *) echo "gitleaks: unsupported architecture $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac \
    && archive="gitleaks_${GITLEAKS_VERSION}_linux_${arch}.tar.gz" \
    && curl -fsSLo "/tmp/${archive}" "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/${archive}" \
    && echo "${sha}  /tmp/${archive}" | sha256sum -c - \
    && tar -xzf "/tmp/${archive}" -C /usr/local/bin --no-same-owner gitleaks \
    && rm "/tmp/${archive}" \
    && gitleaks version

# pnpm for pnpm workspaces (Node 26 no longer bundles corepack). Pinned; a project whose packageManager names
# another pnpm version gets it downloaded by pnpm itself. The store lands in the workspaces volume on its own
# (symphony-workspaces/.pnpm-store, same filesystem as the checkouts, so pnpm hardlinks instead of copying).
ARG PNPM_VERSION=10.34.7
RUN npm install -g --no-audit --no-fund "pnpm@${PNPM_VERSION}" \
    && npm cache clean --force \
    && pnpm --version

# yarn through a pinned corepack (Node 26 no longer bundles it). Only the yarn shim is enabled; pnpm stays the
# global install above. Corepack gets its own prefix: `npm install -g corepack` would also link pnpm and pnpx
# into /usr/local/bin and fail with EEXIST against the pnpm above. Without a packageManager field corepack uses its known yarn 1 (DEFAULT_TO_LATEST=0
# instead of the newest Berry); a project that pins another version gets it downloaded into COREPACK_HOME.
# YARN_VERSION itself is pre-warmed as user symphony further down.
ARG COREPACK_VERSION=0.36.0
ARG YARN_VERSION=1.22.22
ENV COREPACK_HOME=/home/symphony/.cache/corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    COREPACK_DEFAULT_TO_LATEST=0
RUN npm install --prefix /opt/corepack --no-audit --no-fund "corepack@${COREPACK_VERSION}" \
    && ln -s /opt/corepack/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack \
    && corepack enable --install-directory /usr/local/bin yarn \
    && npm cache clean --force

# Headless Chromium and Playwright for UI screenshots (symphony-screenshot or the agent's own Playwright scripts).
# --with-deps installs the system libraries and fonts as root; agents have no sudo. /node_modules links to the
# package so `import { chromium } from 'playwright'` resolves from every script (ESM ignores NODE_PATH).
# WITH_BROWSER=false leaves it out (about 600 MB smaller).
ARG WITH_BROWSER=true
ARG PLAYWRIGHT_VERSION=1.64.0
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN if [ "${WITH_BROWSER}" = "true" ]; then \
        npm install --prefix /opt/playwright --no-audit --no-fund "playwright@${PLAYWRIGHT_VERSION}" \
        && npm cache clean --force \
        && ln -s /opt/playwright/node_modules /node_modules \
        && /opt/playwright/node_modules/.bin/playwright install --with-deps --only-shell chromium \
        && rm -rf /var/lib/apt/lists/*; \
    fi

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
        /home/symphony/.cache/composer \
        /home/symphony/.cache/corepack

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
COPY roles/ ./roles/
COPY --chmod=0755 bin/ ./bin/
RUN ln -s /app/bin/screenshot.mjs /usr/local/bin/symphony-screenshot

USER symphony

# Pre-warm the default yarn so the normal case needs no download at run time.
RUN corepack install -g "yarn@${YARN_VERSION}" && (cd /tmp && yarn --version)

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD [ -z "${SYMPHONY_PORT:-}" ] || curl -fsS "http://127.0.0.1:${SYMPHONY_PORT}/api/v1/state" >/dev/null

ENTRYPOINT ["/usr/bin/tini", "--", "/app/docker/entrypoint.sh"]
