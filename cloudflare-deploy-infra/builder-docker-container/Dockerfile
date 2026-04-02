FROM docker.io/cloudflare/sandbox:0.6.9

# Set command timeout to 10 min
ENV COMMAND_TIMEOUT_MS=600000

# Install package managers globally (these work across node versions)
RUN npm install -g pnpm yarn

# Install system dependencies
RUN apt-get update && apt-get install -y \
    jq \
    git-lfs \
    build-essential \
    curl \
    libssl-dev \
    libreadline-dev \
    zlib1g-dev \
    libyaml-dev \
    libffi-dev \
    && rm -rf /var/lib/apt/lists/*

# Install mise (modern replacement for asdf)
RUN curl https://mise.run | sh && \
    echo 'eval "$(/root/.local/bin/mise activate bash)"' >> /root/.bashrc
ENV PATH="/root/.local/bin:${PATH}"

# Pre-install common tool versions via mise for fast builds
# These are fallback versions when .tool-versions is not present
# Users can override by providing .tool-versions in their project

# Node.js versions (18, 20, 22)
RUN mise install node@18 node@20 node@22

# Ruby versions (3.2, 3.3)
RUN mise install ruby@3.2 ruby@3.3

# Hugo versions (current 0.152.2 + 0.120.0 for compatibility)
RUN mise install hugo@0.152.2 hugo@0.120.0

# Go version (current)
RUN mise install go@1.25.4

# Set default global versions (can be overridden by .tool-versions)
RUN mise use -g node@22 ruby@3.3 hugo@0.152.2 go@1.25.4

# Build tool versions
ARG OPENNEXTJS_VERSION=1.14.8
ARG WRANGLER_VERSION=4.58.0
# Install build tools (opennext, wrangler) to a fixed location that's independent of
# the active Node.js version. This avoids needing to reinstall when mise switches Node versions.
ENV BUILD_TOOLS_DIR=/opt/build-tools
RUN mkdir -p ${BUILD_TOOLS_DIR} && \
    cd ${BUILD_TOOLS_DIR} && \
    npm init -y && \
    npm install @opennextjs/cloudflare@${OPENNEXTJS_VERSION} wrangler@${WRANGLER_VERSION}
ENV PATH="${BUILD_TOOLS_DIR}/node_modules/.bin:${PATH}"

# Create directories for config files
RUN mkdir -p /workspace/config

# Copy build scripts
COPY container-files/*.sh /workspace/
RUN chmod +x /workspace/*.sh

# Copy configuration templates (for Next.js)
COPY container-files/wrangler.jsonc /workspace/config/wrangler.jsonc
COPY container-files/open-next.config /workspace/config/open-next.config.ts
COPY container-files/public/_headers /workspace/config/public/_headers
