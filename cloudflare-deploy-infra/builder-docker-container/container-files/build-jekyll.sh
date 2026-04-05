#!/bin/bash
#
# build-jekyll.sh - Builds Jekyll static sites
#
# Jekyll is a Ruby-based static site generator. This script handles:
# - Ruby gem dependencies via Bundler
# - npm dependencies for sites with Node.js assets
# - Standard Jekyll builds
#
# Output: .static-site/assets/ directory with built site
#
# Usage: ./build-jekyll.sh /path/to/project
#

set -e

PROJECT_DIR="${1:-/workspace/project}"

cd "$PROJECT_DIR" || { echo "ERROR: Failed to change to project directory" >&2; exit 1; }

error_exit() {
    echo "ERROR: $1" >&2
    exit 1
}

export BUNDLE_SILENCE_ROOT_WARNING=true

# Ensure Bundler is installed (will use version from Gemfile.lock)
if ! command -v bundle &> /dev/null; then
    echo "Installing Bundler..."
    gem install bundler || error_exit "Failed to install Bundler"
fi

# Install Ruby dependencies
echo "Installing Ruby dependencies..."
bundle config set --local path 'vendor/bundle'
bundle install || error_exit "Bundle install failed"

# Check for npm dependencies (sites with Node.js assets)
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

# Build the site with production environment
JEKYLL_ENV=production bundle exec jekyll build || error_exit "Jekyll build failed"

# Verify output
[ ! -f "_site/index.html" ] && error_exit "Jekyll build did not produce _site/index.html"

# Create standardized output structure for the deployer
mkdir -p .static-site/assets
cp -r _site/* .static-site/assets/

FILE_COUNT=$(find .static-site/assets -type f | wc -l | tr -d ' ')
echo "Jekyll build complete: $FILE_COUNT files"