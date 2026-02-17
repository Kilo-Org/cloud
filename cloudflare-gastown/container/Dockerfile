FROM node:22-slim

# Install git and gh CLI
RUN apt-get update && \
    apt-get install -y --no-install-recommends git curl && \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends gh && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Install Kilo CLI globally
RUN npm install -g @kilocode/cli

# Create workspace directories
RUN mkdir -p /workspace/rigs /app

WORKDIR /app

# Copy container package files and install deps
COPY package.json ./
RUN npm install --production

# Copy compiled control server
COPY dist/ ./dist/

# Expose control server port (required for local dev)
EXPOSE 8080

CMD ["node", "dist/main.js"]
