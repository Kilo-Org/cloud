#!/bin/bash
#
# build-static.sh - Packages pre-built static sites for deployment
#
# This script is for pure static sites that are already built (no npm build needed).
# Examples: Hugo output, Jekyll output, plain HTML/CSS/JS sites.
#
# Note: The worker script is NOT included here - it's injected by the deployer
# for security reasons (prevents user tampering).
#
# Usage: ./build-static.sh <project_dir> <assets_dir>
#   project_dir: Path to the project directory
#   assets_dir: Relative path to the assets directory (e.g., "dist", "build", ".")
#

set -e

PROJECT_DIR="${1:-/workspace/project}"
ASSETS_DIR="${2:-.}"

error_exit() {
    echo "ERROR: $1" >&2
    exit 1
}

cd "$PROJECT_DIR" || error_exit "Failed to change to project directory"

# Resolve the assets path
if [ "$ASSETS_DIR" = "." ]; then
    ASSETS_PATH="$PROJECT_DIR"
else
    ASSETS_PATH="$PROJECT_DIR/$ASSETS_DIR"
fi

# Validate assets directory exists and has index.html
[ ! -d "$ASSETS_PATH" ] && error_exit "Assets directory not found"
[ ! -f "$ASSETS_PATH/index.html" ] && error_exit "index.html not found"

echo "Preparing static files..."

# Create standardized output structure for the deployer
# .static-site/assets/ - The actual static files
# Worker script is injected by the deployer, not included here
mkdir -p .static-site/assets

# Copy all assets
if [ "$ASSETS_DIR" = "." ]; then
    # For plain-html sites, copy everything except hidden files and our output dirs
    find "$ASSETS_PATH" -maxdepth 1 -type f ! -name '.*' -exec cp {} .static-site/assets/ \;
    find "$ASSETS_PATH" -maxdepth 1 -type d ! -name '.*' ! -name '.static-site' ! -name 'node_modules' ! -path "$ASSETS_PATH" -exec cp -r {} .static-site/assets/ \;
else
    # For prebuilt sites, copy the entire output directory contents
    cp -r "$ASSETS_PATH"/* .static-site/assets/
fi

# Count files for logging
FILE_COUNT=$(find .static-site/assets -type f | wc -l | tr -d ' ')
echo "Found $FILE_COUNT files"

# Verify output exists
[ ! -f ".static-site/assets/index.html" ] && error_exit "Packaging failed - index.html missing"

echo "Static files ready"
exit 0