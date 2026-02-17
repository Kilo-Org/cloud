FROM ubuntu:22.04

# Pinned versions for reproducible builds
ENV NODE_VERSION=22.13.1
ENV DOLT_VERSION=1.35.0
ENV KILO_CLI_VERSION=1.0.23

# Avoid interactive prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive

# Install system dependencies.
# git-core PPA provides >=2.40 (Ubuntu 22.04 default is 2.34).
# tmux from source provides >=3.3 (Ubuntu 22.04 default is 3.2a).
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       software-properties-common \
    && add-apt-repository -y ppa:git-core/ppa \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates \
       curl \
       git \
       jq \
       xz-utils \
       unzip \
       openssh-client \
       # tmux build deps
       libevent-dev libncurses-dev build-essential bison pkg-config autoconf automake \
    && rm -rf /var/lib/apt/lists/*

# Verify git version (>=2.40 required for worktree support)
RUN git_major=$(git --version | sed 's/git version //' | cut -d. -f1) \
    && git_minor=$(git --version | sed 's/git version //' | cut -d. -f2) \
    && if [ "$git_major" -lt 2 ] || { [ "$git_major" -eq 2 ] && [ "$git_minor" -lt 40 ]; }; then \
         echo "FATAL: git $(git --version) is too old, need >=2.40" >&2; exit 1; \
       fi \
    && echo "git version OK: $(git --version)"

# Build tmux >=3.3 from source (Ubuntu 22.04 only ships 3.2a)
ENV TMUX_VERSION=3.4
RUN curl -fsSL "https://github.com/tmux/tmux/releases/download/${TMUX_VERSION}/tmux-${TMUX_VERSION}.tar.gz" -o /tmp/tmux.tar.gz \
    && tar -xzf /tmp/tmux.tar.gz -C /tmp \
    && cd /tmp/tmux-${TMUX_VERSION} \
    && ./configure --prefix=/usr/local \
    && make -j"$(nproc)" \
    && make install \
    && rm -rf /tmp/tmux* \
    && tmux -V

# Clean up build dependencies no longer needed at runtime
RUN apt-get purge -y build-essential bison pkg-config autoconf automake software-properties-common \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js (required by Kilo CLI and gastown.js plugin)
RUN ARCH="$(dpkg --print-architecture)" \
    && case "${ARCH}" in \
         amd64) NODE_ARCH="x64" ;; \
         arm64) NODE_ARCH="arm64" ;; \
         *) echo "Unsupported architecture: ${ARCH}" >&2; exit 1 ;; \
       esac \
    && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" -o /tmp/node.tar.xz \
    && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
    && rm /tmp/node.tar.xz \
    && node --version \
    && npm --version

# Install Dolt (per-rig SQL database)
RUN ARCH="$(dpkg --print-architecture)" \
    && curl -fsSL "https://github.com/dolthub/dolt/releases/download/v${DOLT_VERSION}/dolt-linux-${ARCH}.tar.gz" -o /tmp/dolt.tar.gz \
    && tar -xzf /tmp/dolt.tar.gz -C /tmp \
    && mv /tmp/dolt-linux-*/bin/dolt /usr/local/bin/dolt \
    && rm -rf /tmp/dolt* \
    && dolt version

# Install gt (gastown binary)
# The gt binary must be provided as a build artifact in bin/.
# CI/CD should download the correct platform binary before building.
# TODO: Replace with a goreleaser download URL once release artifacts are published.
COPY --chmod=755 bin/gt /usr/local/bin/gt

# Install Kilo CLI
RUN npm install -g @kilocode/cli@${KILO_CLI_VERSION} \
    && kilo --version

# Create gt user and home directory structure
ENV GT_HOME=/home/gt
RUN useradd -m -d /home/gt -s /bin/bash gt \
    && mkdir -p /home/gt/.gt/settings

# Copy town config and fix ownership
COPY town-config.json /home/gt/.gt/settings/config.json
RUN chown -R gt:gt /home/gt/.gt

# Copy startup script
COPY --chmod=755 startup.sh /usr/local/bin/startup.sh

# Data volume mount point (50GB persistent volume on Fly.io)
VOLUME /home/gt/data

# Internal API port (control plane, built in PR 3)
EXPOSE 8080

# Switch to gt user
USER gt
WORKDIR /home/gt

ENTRYPOINT ["/usr/local/bin/startup.sh"]
