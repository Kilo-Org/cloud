#!/bin/bash
#
# install-deps.sh - Detects package manager and installs dependencies
#
# Detects the package manager based on lockfile and installs dependencies.
# Outputs the detected package manager name on success.
#
# Usage: ./install-deps.sh <project_dir>
#

set -e

PROJECT_DIR="${1:-/workspace/project}"

error_exit() {
    echo "ERROR: $1" >&2
    exit 1
}

[ ! -f "$PROJECT_DIR/package.json" ] && error_exit "package.json not found"

cd "$PROJECT_DIR" || error_exit "Failed to change directory"

# Detect package manager based on lockfile
if [ -f "bun.lockb" ] || [ -f "bun.lock" ]; then
    PKG_MANAGER="bun"
    INSTALL_CMD="bun install --frozen-lockfile"
elif [ -f "pnpm-lock.yaml" ]; then
    PKG_MANAGER="pnpm"
    INSTALL_CMD="pnpm install --frozen-lockfile --silent --ignore-scripts"
elif [ -f "yarn.lock" ]; then
    PKG_MANAGER="yarn"
    INSTALL_CMD="yarn install --frozen-lockfile --silent --ignore-scripts"
elif [ -f "package-lock.json" ]; then
    PKG_MANAGER="npm"
    INSTALL_CMD="npm ci --silent --ignore-scripts"
else
    error_exit "No lockfile found. Please include a package-lock.json, yarn.lock, pnpm-lock.yaml, bun.lockb, or bun.lock file"
fi

echo "Using $PKG_MANAGER"

$INSTALL_CMD || error_exit "Failed to install dependencies"

echo "Dependencies installed"