#!/bin/bash
#
# build-hugo.sh - Builds Hugo static sites
#
# Hugo is a static site generator written in Go. This script handles:
# - Hugo modules (requires Go)
# - npm dependencies for themes with PostCSS/Tailwind
# - Standard Hugo builds
#
# Output: .static-site/assets/ directory with built site
#
# Usage: ./build-hugo.sh /path/to/project
#

set -e

PROJECT_DIR="${1:-/workspace/project}"

cd "$PROJECT_DIR" || { echo "ERROR: Failed to change to project directory" >&2; exit 1; }

error_exit() {
    echo "ERROR: $1" >&2
    exit 1
}

# Check for Hugo modules (requires Go)
if [ -f "go.mod" ]; then
    echo "Hugo modules detected, fetching..."
    hugo mod get || echo "Warning: Could not fetch Hugo modules"
fi

# Check for npm dependencies (themes with PostCSS/Tailwind)
if [ -f "package.json" ]; then
    echo "Installing npm dependencies..."
    if [ -f "pnpm-lock.yaml" ]; then
        pnpm install
    elif [ -f "yarn.lock" ]; then
        yarn install
    elif [ -f "bun.lockb" ] || [ -f "bun.lock" ]; then
        bun install
    else
        npm install
    fi
fi

# Build the site with garbage collection and minification
hugo --gc --minify || error_exit "Hugo build failed"

# Verify output
[ ! -f "public/index.html" ] && error_exit "Hugo build did not produce public/index.html"

# Create standardized output structure for the deployer
mkdir -p .static-site/assets
cp -r public/* .static-site/assets/

FILE_COUNT=$(find .static-site/assets -type f | wc -l | tr -d ' ')
echo "Hugo build complete: $FILE_COUNT files"