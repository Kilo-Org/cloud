#!/bin/bash
#
# build-astro.sh - Builds Astro static sites
#
# Astro is a modern static site builder. This script handles:
# - Validates Astro is configured for static output
# - Runs astro build to generate static files in dist/
# - Copies output to standardized .static-site/assets/ directory
#
# Output: .static-site/assets/ directory with built site
#
# Usage: ./build-astro.sh /path/to/project
#

set -e

PROJECT_DIR="${1:-/workspace/project}"

cd "$PROJECT_DIR" || { echo "ERROR: Failed to change to project directory" >&2; exit 1; }

error_exit() {
    echo "ERROR: $1" >&2
    exit 1
}

echo "Building Astro site..."

# Detect package manager (already installed deps via install-deps.sh)
if [ -f "pnpm-lock.yaml" ]; then
    PKG_MANAGER="pnpm"
elif [ -f "yarn.lock" ]; then
    PKG_MANAGER="yarn"
elif [ -f "bun.lockb" ] || [ -f "bun.lock" ]; then
    PKG_MANAGER="bun"
else
    PKG_MANAGER="npm"
fi

# Check if astro.config exists and warn about SSR mode
for config in astro.config.mjs astro.config.ts astro.config.js; do
    if [ -f "$config" ]; then
        # Check if output is set to 'server' (SSR mode - not supported)
        if grep -q "output.*:.*['\"]server['\"]" "$config" 2>/dev/null; then
            error_exit "Astro SSR mode (output: 'server') is not yet supported. Please use static mode (output: 'static' or remove the output option)"
        fi
        break
    fi
done

# Build the site
echo "Running astro build..."
$PKG_MANAGER run build || error_exit "Astro build failed"

# Determine output directory (default: dist)
OUTPUT_DIR="dist"

# Verify output
[ ! -d "$OUTPUT_DIR" ] && error_exit "Astro build did not produce $OUTPUT_DIR directory"
[ ! -f "$OUTPUT_DIR/index.html" ] && error_exit "Astro build did not produce $OUTPUT_DIR/index.html"

# Create standardized output structure for the deployer
mkdir -p .static-site/assets
cp -r "$OUTPUT_DIR"/* .static-site/assets/

FILE_COUNT=$(find .static-site/assets -type f | wc -l | tr -d ' ')
echo "Astro build complete: $FILE_COUNT files"