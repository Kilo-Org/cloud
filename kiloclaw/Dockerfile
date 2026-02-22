FROM debian:bookworm-slim

# Install Node.js 22 (required by OpenClaw)
ENV NODE_VERSION=22.13.1
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates curl git xz-utils unzip \
    && ARCH="$(dpkg --print-architecture)" \
    && case "${ARCH}" in \
         amd64) NODE_ARCH="x64" ;; \
         arm64) NODE_ARCH="arm64" ;; \
         *) echo "Unsupported architecture: ${ARCH}" >&2; exit 1 ;; \
       esac \
    && curl -fsSL https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz -o /tmp/node.tar.xz \
    && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
    && rm /tmp/node.tar.xz \
    && apt-get purge -y xz-utils \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/* \
    && node --version \
    && npm --version

# Install pnpm globally
RUN npm install -g pnpm

# Install OpenClaw
# Pin to specific version for reproducible builds
RUN npm install -g openclaw@2026.2.9 \
    && openclaw --version

# Install pinned Bun (build-time only) and compile the controller bundle.
ARG BUN_VERSION=1.2.4
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"
ENV PATH="/root/.bun/bin:$PATH"

COPY controller/ /tmp/controller-build/
RUN cd /tmp/controller-build \
    && bun install --frozen-lockfile \
    && bun build src/index.ts --outfile=/usr/local/bin/kiloclaw-controller.js --target=node --minify \
    && rm -rf /tmp/controller-build

# Create OpenClaw directories
# When a Fly Volume is mounted at /root, these dirs persist across restarts.
RUN mkdir -p /root/.openclaw \
    && mkdir -p /root/clawd \
    && mkdir -p /root/clawd/skills

# Copy startup script
# Build cache bust: 2026-02-21-v47-controller-phase1
RUN echo "4"
COPY start-openclaw.sh /usr/local/bin/start-openclaw.sh
COPY openclaw-pairing-list.js /usr/local/bin/openclaw-pairing-list.js
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
