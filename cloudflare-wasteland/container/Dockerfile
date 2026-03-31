FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y \
    curl git ca-certificates jq \
    && rm -rf /var/lib/apt/lists/*

# Install Wasteland CLI (remote mode — no Dolt needed)
# Pin to specific version for reproducibility
ARG WL_VERSION=0.3.0
RUN curl -fsSL https://github.com/gastownhall/wasteland/releases/download/v${WL_VERSION}/wasteland_${WL_VERSION}_linux_amd64.tar.gz \
    | tar xz -C /usr/local/bin/

# Install Bun for the control server
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

WORKDIR /app
COPY control-server/ /app/
RUN bun install --frozen-lockfile || bun install

EXPOSE 8080
CMD ["bun", "run", "server.ts"]
