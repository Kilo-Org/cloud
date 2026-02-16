FROM docker.io/cloudflare/sandbox:0.6.7

# Build arguments for metadata (all optional with defaults)
ARG BUILD_DATE=""
ARG VCS_REF=""
ARG KILOCODE_CLI_VERSION="latest"

RUN mkdir -p -m 755 /etc/apt/keyrings \
	&& out=$(mktemp) && wget -nv -O$out https://cli.github.com/packages/githubcli-archive-keyring.gpg \
	&& cat $out | tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \
	&& chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
	&& mkdir -p -m 755 /etc/apt/sources.list.d \
	&& echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
	&& apt update \
	&& apt install gh -y

# Install GitLab CLI (glab) - download official .deb from GitLab releases
RUN GLAB_VERSION="1.82.0" \
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

# Build the wrapper bundle
RUN cd /tmp/wrapper-build/wrapper && \
    bun build src/main.ts --outfile=/usr/local/bin/kilocode-wrapper.js --target=bun --minify && \
    rm -rf /tmp/wrapper-build

# DO NOT override USER, WORKDIR, or ENTRYPOINT from the base image
# The Cloudflare sandbox base image has its own startup.sh script that must run
# Installing packages globally makes them accessible regardless of the user
