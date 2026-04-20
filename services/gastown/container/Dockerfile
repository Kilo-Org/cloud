FROM oven/bun:1-slim

# Install dev toolchain, search tools, build deps, gh CLI, and Node.js
# Package categories:
#   version control: git, git-lfs
#   network/download: curl, wget, ca-certificates, gnupg, unzip
#   build toolchain: build-essential, autoconf, cmake, pkg-config
#   search tools: ripgrep, jq
#   compression: bzip2, zstd
#   SSL/crypto: libssl-dev, libffi-dev
#   database client libs: libdb-dev, libgdbm-dev, libgdbm6
#   Python build deps: libbz2-dev, liblzma-dev, libncurses5-dev, libreadline-dev, zlib1g-dev
#   Ruby build deps: libyaml-dev
#   image processing: libvips-dev
#   browser/rendering: libgbm1
#   C++ stdlib: libc++1
#   math: libgmp-dev
#   timezone data: tzdata
#   Java: default-jdk
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      git \
      git-lfs \
      curl \
      wget \
      ca-certificates \
      gnupg \
      unzip \
      build-essential \
      autoconf \
      cmake \
      pkg-config \
      ripgrep \
      jq \
      bzip2 \
      zstd \
      libssl-dev \
      libffi-dev \
      libdb-dev \
      libgdbm-dev \
      libgdbm6 \
      libbz2-dev \
      liblzma-dev \
      libncurses5-dev \
      libreadline-dev \
      zlib1g-dev \
      libyaml-dev \
      libvips-dev \
      libgbm1 \
      libc++1 \
      libgmp-dev \
      tzdata \
      default-jdk \
    && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
         -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
         > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

RUN git lfs install --system

# Install Kilo CLI globally via npm (needs real Node.js runtime).
# npm's global install does not resolve optionalDependencies, so we must
# explicitly install the platform-specific binary package alongside the CLI.
# Also install @kilocode/plugin globally so repo-local tools (e.g.
# .opencode/tool/*.ts) can resolve it without a local node_modules.
# Install both glibc and musl variants — the CLI's binary resolver may
# pick either depending on the detected libc.
# Also install pnpm — many projects use it as their package manager.
RUN npm install -g @kilocode/cli@7.2.14 @kilocode/cli-linux-x64@7.2.14 @kilocode/cli-linux-x64-musl@7.2.14 @kilocode/plugin@7.2.14 pnpm && \
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

# ── Git config for agent user ───────────────────────────────────────
# Skip LFS smudge filter: agents don't need binary assets and LFS
# downloads can fail when credentials don't cover the batch endpoint.
# Also disable LFS fetch entirely so clone/worktree never stalls.
RUN printf '[filter "lfs"]\n\tsmudge = git-lfs smudge --skip -- %%f\n\tprocess = git-lfs filter-process --skip\n\tclean = git-lfs clean -- %%f\n\trequired = true\n[lfs]\n\tfetchexclude = *\n' \
      > /home/agent/.gitconfig && \
    chown agent:agent /home/agent/.gitconfig

WORKDIR /app

# ── Install production deps via pnpm ────────────────────────────────
# package.json uses pnpm catalog: references for shared versions.
# pnpm-workspace.yaml (catalog only) and pnpm-lock.yaml are copied
# from the monorepo root by `pnpm container:prepare`.
# package.prod.json is package.json with workspace: devDeps removed.
COPY pnpm-workspace.yaml pnpm-lock.yaml ./
COPY package.prod.json package.json
RUN pnpm install --prod

# Copy source (bun runs TypeScript directly — no build step needed)
COPY src/ ./src/

RUN chown -R agent:agent /app

# Explicitly set HOME so kilo resolves XDG paths correctly.
# Some container runtimes don't set HOME when switching USER.
ENV HOME=/home/agent
USER agent

EXPOSE 8080

CMD ["bun", "run", "src/main.ts"]
