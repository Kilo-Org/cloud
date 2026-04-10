# Global build args — declared before any FROM so they're available to all stages.
ARG CONTROLLER_COMMIT=unknown
ARG CONTROLLER_CACHE_BUST=1

FROM debian:bookworm-slim AS runtime

# Install Node.js 24 (required by OpenClaw)
ENV NODE_VERSION=24.14.1
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates curl gnupg git xz-utils unzip jq ripgrep rsync zstd \
       build-essential python3 ffmpeg tmux chromium \
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
    && apt-get install -y --no-install-recommends gh 1password-cli \
    && apt-get purge -y xz-utils \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/* \
    && node --version \
    && npm --version

# Install pnpm globally
RUN npm install -g pnpm

# Install OpenClaw
# Pin to specific version for reproducible builds
# Patch: bump model discovery timeout from 5s to 60s — shared-cpu machines
# under boot load routinely need 27-35s for the first TLS+fetch to complete.
# Remove this sed patch once openclaw exposes a configurable timeout.
# Workaround: openclaw@2026.4.5 is missing bundled channel plugin runtime deps
# that were removed in the "move bundled extension deps to plugin packages" refactor
# and re-added in openclaw@2026.4.9 via "mirror bundled channel deps at root (#63065)".
# Install them globally so openclaw can resolve them at runtime.
# Remove this block when upgrading to openclaw >= 2026.4.9.
RUN npm install -g \
    @buape/carbon@0.14.0 \
    @grammyjs/runner@^2.0.3 \
    @grammyjs/transformer-throttler@^1.2.1 \
    @larksuiteoapi/node-sdk@^1.60.0 \
    @slack/bolt@^4.6.0 \
    @slack/web-api@^7.15.0 \
    grammy@^1.42.0 \
    https-proxy-agent@^9.0.0 \
    opusscript@^0.1.1
RUN npm install -g openclaw@2026.4.5 \
    && OC_DIST=/usr/local/lib/node_modules/openclaw/dist \
    && PM_FILE=$(find "$OC_DIST" -name 'provider-models-*.js' | head -1) \
    && if [ -z "$PM_FILE" ]; then echo "ERROR: provider-models-*.js not found in openclaw dist" >&2; exit 1; fi \
    && BEFORE=$(grep -c 'DISCOVERY_TIMEOUT_MS = 5e3' "$PM_FILE") \
    && if [ "$BEFORE" -ne 1 ]; then echo "ERROR: expected exactly 1 occurrence of DISCOVERY_TIMEOUT_MS = 5e3, found $BEFORE — openclaw may have changed" >&2; exit 1; fi \
    && sed -i 's/DISCOVERY_TIMEOUT_MS = 5e3/DISCOVERY_TIMEOUT_MS = 60e3/' "$PM_FILE" \
    && AFTER=$(grep -c 'DISCOVERY_TIMEOUT_MS = 60e3' "$PM_FILE") \
    && if [ "$AFTER" -ne 1 ]; then echo "ERROR: sed patch failed — expected 1 occurrence of 60e3, found $AFTER" >&2; exit 1; fi \
    && if grep -q 'DISCOVERY_TIMEOUT_MS = 5e3' "$PM_FILE"; then echo "ERROR: old 5e3 value still present after patch" >&2; exit 1; fi \
    && echo "OK: patched DISCOVERY_TIMEOUT_MS 5e3 -> 60e3 in $(basename $PM_FILE)" \
    && openclaw --version

# Install ClawHub CLI
RUN npm install -g clawhub

# Install mcporter (MCP server tooling)
RUN npm install -g mcporter@0.7.3

# Install Stream Chat channel plugin for OpenClaw (installed from GitHub, not npm)
ARG STREAM_CHAT_CACHE_BUSTER=1
RUN npm install -g github:Kilo-Org/openclaw-channel-streamchat#fix/plugin-name-resolution

# Install summarize (web page summarization CLI)
RUN npm install -g @steipete/summarize@0.12.0

# Install Kilo CLI (agentic coding assistant for the terminal)
RUN npm install -g @kilocode/cli@7.1.13

# Install Go (available at runtime for users to `go install` additional tools)
ENV GO_VERSION=1.26.0
RUN ARCH="$(dpkg --print-architecture)" \
    && curl -fsSL https://dl.google.com/go/go${GO_VERSION}.linux-${ARCH}.tar.gz -o /tmp/go.tar.gz \
    && EXPECTED_SHA256="$(curl -fsSL https://dl.google.com/go/go${GO_VERSION}.linux-${ARCH}.tar.gz.sha256)" \
    && echo "${EXPECTED_SHA256}  /tmp/go.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/go.tar.gz -C /usr/local \
    && rm /tmp/go.tar.gz
# IMPORTANT: A Fly Volume is mounted at /root at runtime, which shadows
# everything the image layer writes under /root.
# - Pre-installed tools use GOBIN=/usr/local/bin so they survive the mount.
# - At runtime, Go defaults to GOBIN=/root/go/bin (on the persistent volume),
#   so user-installed tools persist across restarts and are included in snapshots.
# - npm/Node (installed to /usr/local) and apt packages (/usr/bin) are unaffected.
ENV PATH="/usr/local/go/bin:/root/go/bin:$PATH"
RUN GOBIN=/usr/local/bin go install github.com/steipete/gogcli/cmd/gog@v0.12.0 \
    && GOBIN=/usr/local/bin go install github.com/steipete/goplaces/cmd/goplaces@v0.3.0 \
    && GOBIN=/usr/local/bin go install github.com/Hyaxia/blogwatcher/cmd/blogwatcher@v0.0.2 \
    && GOBIN=/usr/local/bin go install github.com/xdevplatform/xurl@v1.0.3 \
    && GOBIN=/usr/local/bin go install github.com/steipete/gifgrep/cmd/gifgrep@v0.2.3 \
    && go clean -cache -modcache

# Install uv (Python package manager, available at runtime).
# Install to /usr/local/bin so the binary survives the Fly Volume mount at /root.
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh \
    && uv --version

# ── Builder stage: package customizer plugin ───────────────────────────
# Build the vendored plugin tarball in an isolated stage so dev-time
# dependencies do not inflate the runtime image layers.
FROM runtime AS customizer-builder

COPY plugins/kiloclaw-customizer/ /tmp/kiloclaw-customizer/
RUN cd /tmp/kiloclaw-customizer \
    && npm install --include=dev --legacy-peer-deps --no-fund --no-audit \
    && PKG_TGZ="$(npm pack --silent)" \
    && mv "${PKG_TGZ}" /tmp/kiloclaw-customizer.tgz \
    && cd / \
    && rm -rf /tmp/kiloclaw-customizer /root/.npm

# ── Builder stage: compile the controller with Bun ────────────────────
# Bun is only needed to bundle the controller TypeScript into a single JS
# file. By building in a separate stage, Bun (~100MB) stays out of the
# final image. Bun installed to /root/.bun/ which gets shadowed by the
# Fly Volume mount at /root, so it was unreachable at runtime anyway.
FROM debian:bookworm-slim AS controller-builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl unzip \
    && curl -fsSL https://bun.sh/install | bash -s "bun-v1.2.4" \
    && rm -rf /var/lib/apt/lists/*
ENV PATH="/root/.bun/bin:$PATH"

# Re-declare global ARGs to make them available in this stage
ARG CONTROLLER_COMMIT
ARG CONTROLLER_CACHE_BUST
COPY controller/ /tmp/controller-build/
RUN cd /tmp/controller-build \
    && bun install --frozen-lockfile \
    && CONTROLLER_VERSION="$(date -u +'%Y.%-m.%-d')" \
    && bun build src/index.ts --outfile=/usr/local/bin/kiloclaw-controller.js --target=node --minify \
       --define "KILOCLAW_CONTROLLER_VERSION=\"${CONTROLLER_VERSION}\"" \
       --define "KILOCLAW_CONTROLLER_COMMIT=\"${CONTROLLER_COMMIT}\"" \
    && rm -rf /tmp/controller-build

# ── Final stage: runtime image ────────────────────────────────────────
FROM runtime AS final

# Install prebuilt customizer plugin package from builder stage.
COPY --from=customizer-builder /tmp/kiloclaw-customizer.tgz /tmp/kiloclaw-customizer.tgz
RUN npm install -g --legacy-peer-deps /tmp/kiloclaw-customizer.tgz \
    && rm -f /tmp/kiloclaw-customizer.tgz \
    && rm -rf /root/.npm

# Copy the compiled controller from the builder stage
COPY --from=controller-builder /usr/local/bin/kiloclaw-controller.js /usr/local/bin/kiloclaw-controller.js

# Create OpenClaw directories
# When a Fly Volume is mounted at /root, these dirs persist across restarts.
RUN mkdir -p /root/.openclaw \
    && mkdir -p /root/clawd \
    && mkdir -p /root/clawd/skills

# Copy helper scripts (used at runtime by the controller/gateway)
# Build cache bust: 2026-03-17-v65-remove-startup-script
RUN echo "11"
COPY openclaw-pairing-list.js /usr/local/bin/openclaw-pairing-list.js
COPY openclaw-device-pairing-list.js /usr/local/bin/openclaw-device-pairing-list.js

# Copy custom skills
COPY skills/ /root/clawd/skills/

# Stage TOOLS.md outside /root so it survives the Fly Volume mount.
# The controller's bootstrap copies it to /root/.openclaw/workspace/TOOLS.md on first boot.
COPY container/TOOLS.md /usr/local/share/kiloclaw/TOOLS.md

# Expose the gateway port
EXPOSE 18789

# Entrypoint: start the KiloClaw controller daemon directly.
# All bootstrap logic (env decryption, onboard/doctor, config patching,
# feature flags) lives in the controller's bootstrap module — no shell wrapper needed.
CMD ["node", "/usr/local/bin/kiloclaw-controller.js"]
