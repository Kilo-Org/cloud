#!/bin/bash
#
# package-nextjs.sh - Package Next.js build output with Wrangler
#
# Runs wrangler deploy --dry-run to generate the bundled worker.js
# Assumes build-nextjs.sh has already run and .open-next directory exists.
#
# Usage: ./package-nextjs.sh <project_dir>
#

set -e

PROJECT_DIR="${1:-/workspace/project}"

error_exit() {
    echo "ERROR: $1" >&2
    exit 1
}

cd "$PROJECT_DIR" || error_exit "Failed to change directory"

# Verify .open-next directory exists from previous build step
[ ! -d ".open-next" ] && error_exit "Build output not found. Build may have failed"

echo "Packaging application..."

# Run wrangler deploy dry-run to generate worker.js
WRANGLER_SEND_METRICS=false wrangler deploy --dry-run --outdir .bundled-app || error_exit "Packaging failed"

echo "Verifying output..."

# Verify outputs exist
[ ! -f ".bundled-app/worker.js" ] && error_exit "Packaging incomplete"
[ ! -d ".open-next/assets" ] && error_exit "Assets not found"

echo "Application packaged"