FROM oven/bun:1-slim

# Install git, gh CLI, and Node.js (required by @kilocode/cli which uses #!/usr/bin/env node)
RUN apt-get update && \
    apt-get install -y --no-install-recommends git curl ca-certificates && \
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends gh && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Install Kilo CLI globally via npm (needs real Node.js runtime).
# npm's global install does not resolve optionalDependencies, so we must
# explicitly install the platform-specific binary package alongside the CLI.
# Also install @kilocode/plugin globally so repo-local tools (e.g.
# .opencode/tool/*.ts) can resolve it without a local node_modules.
# Install both glibc and musl variants — the CLI's binary resolver may
# pick either depending on the detected libc.
# Also install pnpm — many projects use it as their package manager.
RUN npm install -g @kilocode/cli @kilocode/cli-linux-x64 @kilocode/cli-linux-x64-musl @kilocode/plugin pnpm && \
    ln -s "$(which kilo)" /usr/local/bin/opencode

# Create non-root user for defense-in-depth
RUN useradd -m -s /bin/bash agent

# Create workspace directories
RUN mkdir -p /workspace/rigs /app && chown -R agent:agent /workspace

# ── Gastown plugin ──────────────────────────────────────────────────
# OpenCode discovers local plugins by scanning {plugin,plugins}/*.{ts,js}
# inside each config directory. We install deps into the plugin source
# dir then symlink the entry-point file so the glob finds it. Relative
# imports in index.ts resolve via the symlink's real path (/opt/…).
COPY plugin/ /opt/gastown-plugin/
RUN cd /opt/gastown-plugin && npm install --omit=dev && \
    mkdir -p /home/agent/.config/kilo/plugins && \
    ln -s /opt/gastown-plugin/index.ts /home/agent/.config/kilo/plugins/gastown.ts && \
    chown -R agent:agent /home/agent/.config

WORKDIR /app

# Copy package files and install deps deterministically
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Copy source (bun runs TypeScript directly — no build step needed)
COPY src/ ./src/

RUN chown -R agent:agent /app

USER agent

EXPOSE 8080

CMD ["bun", "run", "src/main.ts"]
