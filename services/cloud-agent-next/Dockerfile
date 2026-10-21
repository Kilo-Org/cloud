ARG NODE_VERSION="24.22.0"
FROM docker.io/library/node:${NODE_VERSION}-slim AS node-runtime

FROM docker.io/cloudflare/sandbox:0.12.12

COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack
COPY --from=node-runtime /usr/local/lib/node_modules /usr/local/lib/node_modules

# Build arguments for metadata (all optional with defaults)
ARG BUILD_DATE=""
ARG VCS_REF=""
ARG KILOCODE_CLI_VERSION="7.8.15"
ARG BUN_VERSION="1.3.14"
ARG PNPM_VERSION="12.14.0"
ARG GLAB_VERSION="1.124.0"
ARG GH_VERSION="2.102.0"

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
	apt-get update; \
	apt-get install -y --no-install-recommends \
		git \
		git-lfs \
		jq \
		libatomic1 \
		openssh-client \
		ripgrep; \
	git lfs install --system --skip-repo; \
	apt-get clean; \
	rm -rf /var/lib/apt/lists/*

RUN wget -nv -O /tmp/gh.tar.gz "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" \
	&& tar -xzf /tmp/gh.tar.gz -C /tmp \
	&& install -m 0755 "/tmp/gh_${GH_VERSION}_linux_amd64/bin/gh" /usr/local/bin/gh \
	&& rm -rf /tmp/gh.tar.gz "/tmp/gh_${GH_VERSION}_linux_amd64"

# Install GitLab CLI (glab) - download official .deb from GitLab releases.
# Version 1.82.0+ is required so OAuth2 access tokens sent via GITLAB_TOKEN are
# authenticated with `Authorization: Bearer` instead of `PRIVATE-TOKEN` (which
# GitLab rejects for OAuth tokens). Enabled via `GLAB_IS_OAUTH2=true` at runtime.
RUN wget -nv -O /tmp/glab.deb "https://gitlab.com/gitlab-org/cli/-/releases/v${GLAB_VERSION}/downloads/glab_${GLAB_VERSION}_linux_amd64.deb" \
	&& dpkg -i /tmp/glab.deb \
	&& rm /tmp/glab.deb

COPY scripts/kilo-git-credential /opt/kilo-cloud/kilo-git-credential
RUN chmod +x /opt/kilo-cloud/kilo-git-credential \
	&& ln -sf /opt/kilo-cloud/kilo-git-credential /usr/local/bin/kilo-git-credential

# Generate locales to suppress setlocale warnings
RUN apt-get update && apt-get install -y --no-install-recommends locales && \
	   sed -i -e 's/# en_US.UTF-8 UTF-8/en_US.UTF-8 UTF-8/' /etc/locale.gen && \
	   locale-gen && \
	   apt-get clean && \
	   rm -rf /var/lib/apt/lists/*
ENV LC_ALL=en_US.UTF-8
ENV LANG=en_US.UTF-8

# Install dependencies globally (accessible to all users)
RUN rm -f /usr/local/bin/bun \
	&& npm install -g bun@${BUN_VERSION} pnpm@${PNPM_VERSION} @kilocode/cli@${KILOCODE_CLI_VERSION}

# === Build wrapper bundle inside container ===
# This ensures the wrapper is built with the same Bun version that will run it,
# avoiding any compatibility issues between build and runtime environments.
# The build entrypoint list lives in src/shared/runtime-distribution.ts.
COPY wrapper /tmp/wrapper-build/wrapper
COPY src/shared /tmp/wrapper-build/src/shared

# Install wrapper dependencies (pnpm symlinks don't survive COPY) and build
RUN cd /tmp/wrapper-build/wrapper && \
    bun install --production && \
    ln -sfn /tmp/wrapper-build/wrapper/node_modules /tmp/wrapper-build/node_modules && \
    bun run build.ts --install-dir /usr/local/bin && \
    rm -rf /tmp/wrapper-build

# DO NOT override USER, WORKDIR, or ENTRYPOINT from the base image
# The Cloudflare sandbox base image entrypoint must run its control server
# Installing packages globally makes them accessible regardless of the user
