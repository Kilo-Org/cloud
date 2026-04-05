#!/bin/bash
# cloud-agent-build.sh
# Builds kilo-cli from source and copies the linux-x64 binary for Docker
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KILO_CLI_DIR="${KILO_CLI_DIR:-$HOME/projects/kilo-cli}"
CLOUD_AGENT_DIR="$SCRIPT_DIR"

echo "==> Building kilo-cli from $KILO_CLI_DIR"

# Verify kilo-cli directory exists
if [ ! -d "$KILO_CLI_DIR" ]; then
    echo "Error: kilo-cli directory not found at $KILO_CLI_DIR"
    echo "Set KILO_CLI_DIR environment variable to override"
    exit 1
fi

# Install dependencies
echo "==> Installing dependencies..."
cd "$KILO_CLI_DIR"
bun install

# Build all targets (includes linux-x64)
echo "==> Building kilo binaries..."
cd "$KILO_CLI_DIR/packages/opencode"
./script/build.ts

# Copy linux-x64 binary to cloud-agent
BINARY_PATH="$KILO_CLI_DIR/packages/opencode/dist/@kilocode/cli-linux-x64/bin/kilo"
if [ ! -f "$BINARY_PATH" ]; then
    echo "Error: Binary not found at $BINARY_PATH"
    exit 1
fi

echo "==> Copying kilo binary to $CLOUD_AGENT_DIR"
cp "$BINARY_PATH" "$CLOUD_AGENT_DIR/kilo"
chmod +x "$CLOUD_AGENT_DIR/kilo"

echo ""
echo "✓ kilo binary ready at $CLOUD_AGENT_DIR/kilo"
echo ""
echo "Next steps:"
echo "  cd $CLOUD_AGENT_DIR"
echo "  pnpm run dev"
