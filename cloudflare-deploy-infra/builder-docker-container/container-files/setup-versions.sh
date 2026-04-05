#!/bin/bash
#
# Sets up tool versions using mise

set -e

PROJECT_DIR="${1:-/workspace/project}"

# Activate mise in current shell
eval "$(/root/.local/bin/mise activate bash)"

# Export mise shims to PATH (ensures mise-installed tools take precedence)
export PATH="/root/.local/share/mise/shims:$PATH"

# Check if .tool-versions or mise.toml exists in the project
if [ -f "$PROJECT_DIR/.tool-versions" ] || [ -f "$PROJECT_DIR/mise.toml" ]; then
    if [ -f "$PROJECT_DIR/.tool-versions" ]; then
        echo "Found .tool-versions, installing specified versions..."
    else
        echo "Found mise.toml, installing specified versions..."
    fi
    
    # Change to project directory so mise picks up configuration
    cd "$PROJECT_DIR"
    
    # Install versions specified in .tool-versions or mise.toml
    # mise install without arguments reads from config in current directory
    # --quiet suppresses progress output to stderr
    mise install --quiet || {
        echo "Warning: mise install failed, falling back to pre-installed versions"
    }
    
    # List active versions for debugging
    echo "Active tool versions:"
    mise current 2>/dev/null || echo "  (could not retrieve versions)"
    
else
    echo "No .tool-versions or mise.toml found, using pre-installed defaults"
    echo "Active tool versions:"
    mise current 2>/dev/null || echo "  (could not retrieve versions)"
fi

# Ensure go binaries are in PATH (Go modules install to $GOPATH/bin)
export GOPATH="${GOPATH:-$HOME/go}"
export PATH="$GOPATH/bin:$PATH"
