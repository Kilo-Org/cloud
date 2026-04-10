FROM node:22

# Install system dependencies required by the kilo-context pipeline.
# git    — required by process/ingest-github.mjs (runs git clone)
# ca-certificates — required for HTTPS fetches inside the container
RUN apt-get update && \
    apt-get install -y git ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# ── Bake the kilo-context product repo ────────────────────────────────────
# Clone at image-build time so every container start is instant.
# The product repo contains all pipeline scripts (process/*.mjs) and the
# source configuration (which Slack channels, GitHub repos, etc. to pull).
# Instance credentials are injected via environment variables at runtime.
WORKDIR /app
RUN git clone --depth 1 https://github.com/kilo-org/kilo-context.git /app

# Install Node.js dependencies.
# node:22 (full image) includes build tools (gcc, python3, make) needed to
# compile native modules such as @lancedb/lancedb.
RUN npm install --ignore-scripts=false

# ── In-container HTTP server ───────────────────────────────────────────────
# server.mjs listens on PORT (default 8080), accepts POST /run, spawns the
# pipeline subprocess, and streams stdout/stderr as a chunked response.
COPY server.mjs /app/server.mjs

EXPOSE 8080

# KB_ROOT is injected at Container spawn time by the Orchestrator.
# It points to the writable workspace directory on the container filesystem.
# The pipeline scripts resolve all paths through process/paths.mjs via KB_ROOT.
ENV KB_ROOT=/workspace/kb
ENV NODE_ENV=production

CMD ["node", "/app/server.mjs"]
