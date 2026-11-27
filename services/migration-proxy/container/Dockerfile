# The migration proxy's container (contract §1). Build context: this directory only, so neither
# the root lockfile nor .pnpmfile.cjs reaches the image. Node is the .nvmrc version, pinned by
# digest; pnpm is pinned by version and sha512 in package.json's packageManager, which corepack
# verifies before it runs. Renovate bumps the digest, the packageManager hash and the lockfile.
FROM node:24.22.1-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c

ENV NODE_ENV=production \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    COREPACK_HOME=/opt/corepack

WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable pnpm \
 && pnpm install --frozen-lockfile --ignore-workspace --ignore-pnpmfile \
 && rm -rf /opt/corepack /root/.cache /root/.local/share/pnpm
COPY ca-bundle.pem ./
COPY src ./src

USER node
EXPOSE 8080
CMD ["node", "src/server.ts"]
