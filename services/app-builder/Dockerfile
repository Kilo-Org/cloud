FROM node:24.22.1-bookworm-slim AS node-runtime

FROM docker.io/cloudflare/sandbox:0.6.7

COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node

RUN apt-get update && apt-get install -y --no-install-recommends iproute2 ca-certificates \
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/*

EXPOSE 8080
