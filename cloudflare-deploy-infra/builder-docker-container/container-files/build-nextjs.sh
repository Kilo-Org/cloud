#!/bin/bash
#
# build-nextjs.sh - Build Next.js application with OpenNext
#
# Uses OpenNext to build Next.js apps for Cloudflare Workers deployment.
# Assumes dependencies are already installed via install-deps.sh.
#
# Usage: ./build-nextjs.sh <project_dir> <config_dir>
#

set -e

PROJECT_DIR="${1:-/workspace/project}"
CONFIG_DIR="${2:-/workspace/config}"

error_exit() {
    echo "ERROR: $1" >&2
    exit 1
}

[ ! -f "$PROJECT_DIR/package.json" ] && error_exit "package.json not found"

cd "$PROJECT_DIR" || error_exit "Failed to change directory"

# Validate Next.js version
NEXTJS_VERSION=$(jq -r '.dependencies.next // .devDependencies.next // ""' package.json | sed 's/[^0-9.]//g' | cut -d. -f1)
[ -z "$NEXTJS_VERSION" ] && error_exit "Next.js not found in package.json"
[ "$NEXTJS_VERSION" != "14" ] && [ "$NEXTJS_VERSION" != "15" ] && [ "$NEXTJS_VERSION" != "16" ] && error_exit "Unsupported Next.js version: $NEXTJS_VERSION"

echo "Next.js version $NEXTJS_VERSION"

# Use build tools from fixed location (independent of active Node.js version)
BUILD_TOOLS_DIR="${BUILD_TOOLS_DIR:-/opt/build-tools}"

[ ! -d "$BUILD_TOOLS_DIR/node_modules/@opennextjs/cloudflare" ] && error_exit "Build environment is not configured correctly"

# Link @opennextjs/cloudflare to local node_modules
mkdir -p node_modules/@opennextjs
ln -sf "$BUILD_TOOLS_DIR/node_modules/@opennextjs/cloudflare" node_modules/@opennextjs/cloudflare || error_exit "Failed to configure build environment"

# Copy config files
cp "$CONFIG_DIR/wrangler.jsonc" ./wrangler.jsonc || error_exit "Failed to configure build"
cp "$CONFIG_DIR/open-next.config.ts" ./open-next.config.ts || error_exit "Failed to configure build"

# Ensure public directory and headers exist
mkdir -p public
[ ! -f "public/_headers" ] && cp "$CONFIG_DIR/public/_headers" ./public/_headers

echo "Building..."
# Use opennextjs-cloudflare binary directly from BUILD_TOOLS_DIR
NEXT_TELEMETRY_DISABLED=1 "$BUILD_TOOLS_DIR/node_modules/.bin/opennextjs-cloudflare" build || error_exit "Build failed"

# Verify .open-next directory exists
[ ! -d ".open-next" ] && error_exit "Build output not found"

echo "Build completed"