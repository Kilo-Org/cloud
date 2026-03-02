FROM debian:bookworm-slim

# Install Node.js 22 (required by OpenClaw)
ENV NODE_VERSION=22.13.1
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates curl gnupg git xz-utils unzip jq ripgrep rsync zstd \
       build-essential python3 ffmpeg tmux \
    && ARCH="$(dpkg --print-architecture)" \
    && case "${ARCH}" in \
         amd64) NODE_ARCH="x64" ;; \
         arm64) NODE_ARCH="arm64" ;; \
         *) echo "Unsupported architecture: ${ARCH}" >&2; exit 1 ;; \
       esac \
    && curl -fsSL https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz -o /tmp/node.tar.xz \
    && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
    && rm /tmp/node.tar.xz \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=${ARCH} signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
    && curl -fsSL https://downloads.1password.com/linux/keys/1password.asc \
       | gpg --dearmor --output /usr/share/keyrings/1password-archive-keyring.gpg \
    && echo "deb [arch=${ARCH} signed-by=/usr/share/keyrings/1password-archive-keyring.gpg] https://downloads.1password.com/linux/debian/${ARCH} stable main" \
       > /etc/apt/sources.list.d/1password.list \
    && mkdir -p /etc/debsig/policies/AC2D62742012EA22/ \
    && curl -fsSL https://downloads.1password.com/linux/debian/debsig/1password.pol \
       | tee /etc/debsig/policies/AC2D62742012EA22/1password.pol > /dev/null \
    && mkdir -p /usr/share/debsig/keyrings/AC2D62742012EA22 \
    && curl -fsSL https://downloads.1password.com/linux/keys/1password.asc \
       | gpg --dearmor --output /usr/share/debsig/keyrings/AC2D62742012EA22/debsig.gpg \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh 1password-cli=2.32.1-1 \
    && apt-get purge -y xz-utils \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/* \
    && node --version \
    && npm --version

# Install pnpm globally
RUN npm install -g pnpm

# Install OpenClaw
# Pin to specific version for reproducible builds
RUN npm install -g openclaw@2026.2.26 \
    && openclaw --version

# Install ClawHub CLI
RUN npm install -g clawhub

# Install mcporter (MCP server tooling)
RUN npm install -g mcporter@0.7.3

# Install pinned Bun (build-time only) and compile the controller bundle.
ARG BUN_VERSION=1.2.4
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"
ENV PATH="/root/.bun/bin:$PATH"

ARG CONTROLLER_COMMIT=unknown
COPY controller/ /tmp/controller-build/
RUN cd /tmp/controller-build \
    && bun install --frozen-lockfile \
    && CONTROLLER_VERSION="$(date -u +'%Y.%-m.%-d')" \
    && bun build src/index.ts --outfile=/usr/local/bin/kiloclaw-controller.js --target=node --minify \
       --define "KILOCLAW_CONTROLLER_VERSION='\"${CONTROLLER_VERSION}\"'" \
       --define "KILOCLAW_CONTROLLER_COMMIT='\"${CONTROLLER_COMMIT}\"'" \
    && rm -rf /tmp/controller-build

# Create OpenClaw directories
# When a Fly Volume is mounted at /root, these dirs persist across restarts.
RUN mkdir -p /root/.openclaw \
    && mkdir -p /root/clawd \
    && mkdir -p /root/clawd/skills

# Copy startup script
# Build cache bust: 2026-02-27-v57-openclaw-2026.2.26-1password-arch-fix
RUN echo "7"
COPY start-openclaw.sh /usr/local/bin/start-openclaw.sh
COPY openclaw-pairing-list.js /usr/local/bin/openclaw-pairing-list.js
COPY openclaw-device-pairing-list.js /usr/local/bin/openclaw-device-pairing-list.js
RUN chmod +x /usr/local/bin/start-openclaw.sh
RUN ls -l /usr/local/bin/start-openclaw.sh \
    && head -n 1 /usr/local/bin/start-openclaw.sh | cat -v \
    && od -An -t x1 -N 4 /usr/local/bin/start-openclaw.sh \
    && ls -l /bin/bash

# Copy custom skills
COPY skills/ /root/clawd/skills/

# Expose the gateway port
EXPOSE 18789

# Entrypoint: start the KiloClaw controller daemon
CMD ["/usr/local/bin/start-openclaw.sh"]
