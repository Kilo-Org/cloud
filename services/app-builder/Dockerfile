FROM node:24-bookworm-slim AS node-runtime

FROM docker.io/cloudflare/sandbox:0.6.7

COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack
COPY --from=node-runtime /usr/local/lib/node_modules /usr/local/lib/node_modules

RUN apt-get update && apt-get install -y --no-install-recommends iproute2 ca-certificates \
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/*

EXPOSE 8080
