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

# Validate Next.js version against the OpenNext support range.
NEXTJS_SPEC=$(jq -r '.dependencies.next // .devDependencies.next // ""' package.json)
[ -z "$NEXTJS_SPEC" ] && error_exit "Next.js not found in package.json"

NEXTJS_VERSION=$(printf '%s' "$NEXTJS_SPEC" | sed -nE 's/^[^0-9]*([0-9]+\.[0-9]+\.[0-9]+).*/\1/p')
if [[ "$NEXTJS_VERSION" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
    NEXTJS_MAJOR="${BASH_REMATCH[1]}"
    NEXTJS_MINOR="${BASH_REMATCH[2]}"
    NEXTJS_PATCH="${BASH_REMATCH[3]}"
else
    error_exit "Unsupported Next.js version spec: $NEXTJS_SPEC. OpenNext requires Next.js >=15.5.18 <16 or >=16.2.6"
fi

NEXTJS_SUPPORTED=false
if [ "$NEXTJS_MAJOR" = "15" ]; then
    [ "$NEXTJS_MINOR" -gt 5 ] || { [ "$NEXTJS_MINOR" -eq 5 ] && [ "$NEXTJS_PATCH" -ge 18 ]; } && NEXTJS_SUPPORTED=true
elif [ "$NEXTJS_MAJOR" = "16" ]; then
    [ "$NEXTJS_MINOR" -gt 2 ] || { [ "$NEXTJS_MINOR" -eq 2 ] && [ "$NEXTJS_PATCH" -ge 6 ]; } && NEXTJS_SUPPORTED=true
fi

[ "$NEXTJS_SUPPORTED" != "true" ] && error_exit "Unsupported Next.js version: $NEXTJS_SPEC. OpenNext requires Next.js >=15.5.18 <16 or >=16.2.6"

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