#!/bin/bash
#
# build-eleventy.sh - Builds Eleventy (11ty) static sites
#
# Eleventy is a simpler, JavaScript-based static site generator. This script handles:
# - npm/pnpm/yarn/bun dependency installation
# - Uses build script if defined, otherwise runs npx @11ty/eleventy
#
# Output: .static-site/assets/ directory with built site
#
# Usage: ./build-eleventy.sh /path/to/project
#

set -e

PROJECT_DIR="${1:-/workspace/project}"

cd "$PROJECT_DIR" || { echo "ERROR: Failed to change to project directory" >&2; exit 1; }

error_exit() {
    echo "ERROR: $1" >&2
    exit 1
}

# Detect package manager
if [ -f "pnpm-lock.yaml" ]; then
    PKG_MANAGER="pnpm"
elif [ -f "yarn.lock" ]; then
    PKG_MANAGER="yarn"
elif [ -f "bun.lockb" ] || [ -f "bun.lock" ]; then
    PKG_MANAGER="bun"
else
    PKG_MANAGER="npm"
fi

# Install dependencies
echo "Installing dependencies with $PKG_MANAGER..."
$PKG_MANAGER install || error_exit "Dependency installation failed"

# Build the site - prefer build script if available
if [ -f "package.json" ] && grep -q '"build"' package.json; then
    echo "Running build script..."
    $PKG_MANAGER run build || error_exit "Eleventy build failed"
else
    echo "Running npx @11ty/eleventy..."
    npx @11ty/eleventy || error_exit "Eleventy build failed"
fi

# Determine output directory (default: _site)
OUTPUT_DIR="_site"

# Verify output
[ ! -f "$OUTPUT_DIR/index.html" ] && error_exit "Eleventy build did not produce $OUTPUT_DIR/index.html"

# Create standardized output structure for the deployer
mkdir -p .static-site/assets
cp -r "$OUTPUT_DIR"/* .static-site/assets/

FILE_COUNT=$(find .static-site/assets -type f | wc -l | tr -d ' ')
echo "Eleventy build complete: $FILE_COUNT files"