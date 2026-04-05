FROM node:24-slim

# Install dependencies for gcloud CLI + readline for interactive prompts
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    python3 \
    apt-transport-https \
    ca-certificates \
    gnupg \
  && rm -rf /var/lib/apt/lists/*

# Install gcloud CLI
RUN curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg \
  && echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" \
    > /etc/apt/sources.list.d/google-cloud-sdk.list \
  && apt-get update && apt-get install -y --no-install-recommends google-cloud-cli \
  && rm -rf /var/lib/apt/lists/*

# Install gogcli v0.12.0 pre-built binary (arch-aware)
ARG TARGETARCH
RUN GOARCH=$([ "$TARGETARCH" = "arm64" ] && echo "arm64" || echo "amd64") \
  && curl -fsSL "https://github.com/steipete/gogcli/releases/download/v0.12.0/gogcli_0.12.0_linux_${GOARCH}.tar.gz" \
    | tar xz -C /usr/local/bin gog \
  && chmod +x /usr/local/bin/gog

WORKDIR /app
COPY setup.mjs ./

ENTRYPOINT ["node", "setup.mjs"]
