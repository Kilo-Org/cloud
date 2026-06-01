FROM docker.io/cloudflare/sandbox:0.10.3

# Build arguments for metadata (all optional with defaults)
ARG BUILD_DATE=""
ARG VCS_REF=""
ARG KILOCODE_CLI_VERSION="7.3.12"

# Install latest stable git + git-lfs from the git-core PPA, GitHub CLI, and supporting tools.
# The default Ubuntu git (2.34.1 on 22.04) is outdated; the git-core PPA ships the latest
# stable release. git-lfs is installed from the same PPA so it stays in lockstep with git,
# and `git lfs install --system` enables LFS smudge/clean filters globally.
RUN set -eux; \
	apt-get update; \
	apt-get install -y --no-install-recommends \
		ca-certificates \
		gnupg \
		software-properties-common \
		wget; \
	add-apt-repository -y ppa:git-core/ppa; \
	mkdir -p -m 755 /etc/apt/keyrings; \
	out=$(mktemp); \
	wget -nv -O "$out" https://cli.github.com/packages/githubcli-archive-keyring.gpg; \
	cat "$out" | tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null; \
	chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg; \
	mkdir -p -m 755 /etc/apt/sources.list.d; \
	echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
		| tee /etc/apt/sources.list.d/github-cli.list > /dev/null; \
	apt-get update; \
	apt-get install -y --no-install-recommends \
		git \
		git-lfs \
		gh \
		jq \
		openssh-client; \
	git lfs install --system --skip-repo; \
	apt-get clean; \
	rm -rf /var/lib/apt/lists/*

# Install GitLab CLI (glab) - download official .deb from GitLab releases.
# Version 1.82.0+ is required so OAuth2 access tokens sent via GITLAB_TOKEN are
# authenticated with `Authorization: Bearer` instead of `PRIVATE-TOKEN` (which
# GitLab rejects for OAuth tokens). Enabled via `GLAB_IS_OAUTH2=true` at runtime.
RUN GLAB_VERSION="1.93.0" \
	&& wget -nv -O /tmp/glab.deb "https://gitlab.com/gitlab-org/cli/-/releases/v${GLAB_VERSION}/downloads/glab_${GLAB_VERSION}_linux_amd64.deb" \
	&& dpkg -i /tmp/glab.deb \
	&& rm /tmp/glab.deb

# Generate locales to suppress setlocale warnings
RUN apt-get update && apt-get install -y --no-install-recommends locales && \
	   sed -i -e 's/# en_US.UTF-8 UTF-8/en_US.UTF-8 UTF-8/' /etc/locale.gen && \
	   locale-gen && \
	   apt-get clean && \
	   rm -rf /var/lib/apt/lists/*
ENV LC_ALL=en_US.UTF-8
ENV LANG=en_US.UTF-8

# Install dependencies globally (accessible to all users)
RUN npm install -g pnpm @kilocode/cli@${KILOCODE_CLI_VERSION}

# === Build wrapper bundle inside container ===
# This ensures the wrapper is built with the same Bun version that will run it,
# avoiding any compatibility issues between build and runtime environments.
# The wrapper imports from ../../src/shared/protocol.js, so we maintain that structure.
COPY wrapper /tmp/wrapper-build/wrapper
COPY src/shared /tmp/wrapper-build/src/shared

# Install wrapper dependencies (pnpm symlinks don't survive COPY) and build
RUN cd /tmp/wrapper-build/wrapper && \
    bun install --production && \
    bun build src/main.ts --outfile=/usr/local/bin/kilocode-wrapper.js --target=bun --minify && \
    bun build src/restore-session.ts --outfile=/usr/local/bin/kilo-restore-session.js --target=bun --minify && \
    rm -rf /tmp/wrapper-build

# DO NOT override USER, WORKDIR, or ENTRYPOINT from the base image
# The Cloudflare sandbox base image has its own startup.sh script that must run
# Installing packages globally makes them accessible regardless of the user
