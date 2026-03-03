#!/bin/bash
#
# Start all services needed for local app builder development
# Uses tmux to create a split terminal with all services running
#
# Services started:
#   - cloudflare-db-proxy (port 8792)
#   - cloudflare-session-ingest (port 8787)
#   - cloud-agent (port 8788)
#   - cloud-agent-next (port 8794)
#   - cloudflare-git-token-service (port 8795)
#   - cloudflare-app-builder (port 8790)
#   - cloudflare-images-mcp (port 8796)
#   - ngrok (forwarding to port 8790)
#
# Requirements:
#   - tmux
#   - ngrok (with authentication configured)
#   - pnpm
#
# Usage:
#   ./cloudflare-app-builder/start-dev.sh           # Start or attach to existing session
#   ./cloudflare-app-builder/start-dev.sh --restart # Force restart (kill existing session)
#
# To kill the session manually:
#   tmux kill-session -t app-builder-dev
#

set -e

SESSION_NAME="app-builder-dev"
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Parse arguments
RESTART=false
for arg in "$@"; do
    case $arg in
        --restart|-r)
            RESTART=true
            shift
            ;;
        --help|-h)
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --restart, -r   Kill existing session and start fresh"
            echo "  --help, -h      Show this help message"
            echo ""
            echo "If a session already exists, this script will attach to it."
            echo "Use --restart to force a fresh start."
            exit 0
            ;;
    esac
done

# Check dependencies
command -v tmux >/dev/null 2>&1 || { echo "Error: tmux is required but not installed."; exit 1; }
command -v ngrok >/dev/null 2>&1 || { echo "Error: ngrok is required but not installed."; exit 1; }
command -v pnpm >/dev/null 2>&1 || { echo "Error: pnpm is required but not installed."; exit 1; }

# Check if session already exists
if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    if [ "$RESTART" = true ]; then
        echo "🔄 Restarting existing session..."
        tmux kill-session -t "$SESSION_NAME"
    else
        echo ""
        echo "╔══════════════════════════════════════════════════════════════════╗"
        echo "║         Attaching to existing session... 🔗                      ║"
        echo "║                                                                  ║"
        echo "║  Tip: Use --restart or -r flag to start fresh                   ║"
        echo "╚══════════════════════════════════════════════════════════════════╝"
        echo ""
        tmux attach -t "$SESSION_NAME"
        exit 0
    fi
fi

# Create new tmux session with first window for db-proxy
tmux new-session -d -s "$SESSION_NAME" -n "services" -c "$PROJECT_ROOT"

# Split into grid for 8 services
# First split horizontally (top/bottom)
tmux split-window -v -t "$SESSION_NAME:services" -c "$PROJECT_ROOT"
# Split top pane vertically into 4
tmux split-window -h -t "$SESSION_NAME:services.0" -c "$PROJECT_ROOT"
tmux split-window -h -t "$SESSION_NAME:services.0" -c "$PROJECT_ROOT"
tmux split-window -h -t "$SESSION_NAME:services.0" -c "$PROJECT_ROOT"
# Split bottom pane vertically into 4
tmux split-window -h -t "$SESSION_NAME:services.4" -c "$PROJECT_ROOT"
tmux split-window -h -t "$SESSION_NAME:services.4" -c "$PROJECT_ROOT"
tmux split-window -h -t "$SESSION_NAME:services.4" -c "$PROJECT_ROOT"

# Arrange panes in a tiled layout
tmux select-layout -t "$SESSION_NAME:services" tiled

# Enable pane titles in border and prevent programs from overriding
tmux set-option -t "$SESSION_NAME" pane-border-status top
tmux set-option -t "$SESSION_NAME" pane-border-format " #{pane_index}: #{pane_title} "
tmux set-option -t "$SESSION_NAME" allow-set-title off

# Pane 0 (top-left): cloudflare-db-proxy
tmux select-pane -t "$SESSION_NAME:services.0" -T "db-proxy (8792)"
# Using different inspector ports to avoid conflicts (default is 9229)
tmux send-keys -t "$SESSION_NAME:services.0" "cd $PROJECT_ROOT/cloudflare-db-proxy && echo '🗄️  Starting cloudflare-db-proxy (port 8792)...' && pnpm exec wrangler dev --inspector-port 9230" C-m

# Pane 1: cloudflare-session-ingest
tmux select-pane -t "$SESSION_NAME:services.1" -T "session-ingest (8787)"
tmux send-keys -t "$SESSION_NAME:services.1" "cd $PROJECT_ROOT/cloudflare-session-ingest && echo '📥 Starting cloudflare-session-ingest (port 8787)...' && pnpm exec wrangler dev --inspector-port 9233" C-m

# Pane 2: cloud-agent
tmux select-pane -t "$SESSION_NAME:services.2" -T "cloud-agent (8788)"
tmux send-keys -t "$SESSION_NAME:services.2" "cd $PROJECT_ROOT/cloud-agent && echo '🤖 Starting cloud-agent (port 8788)...' && pnpm exec wrangler dev --inspector-port 9231" C-m

# Pane 3 (top-right): cloudflare-images-mcp
tmux select-pane -t "$SESSION_NAME:services.3" -T "images-mcp (8796)"
tmux send-keys -t "$SESSION_NAME:services.3" "cd $PROJECT_ROOT/cloudflare-images-mcp && echo '🖼️  Starting cloudflare-images-mcp (port 8796)...' && pnpm exec wrangler dev --env dev --inspector-port 9236" C-m

# Pane 4 (bottom-left): cloudflare-git-token-service
tmux select-pane -t "$SESSION_NAME:services.4" -T "git-token-service (8795)"
tmux send-keys -t "$SESSION_NAME:services.4" "cd $PROJECT_ROOT/cloudflare-git-token-service && echo '🔑 Starting cloudflare-git-token-service (port 8795)...' && pnpm exec wrangler dev --inspector-port 9235" C-m

# Pane 5: cloudflare-app-builder
tmux select-pane -t "$SESSION_NAME:services.5" -T "app-builder (8790)"
tmux send-keys -t "$SESSION_NAME:services.5" "cd $PROJECT_ROOT/cloudflare-app-builder && echo '🏗️  Starting cloudflare-app-builder (port 8790)...' && pnpm exec wrangler dev --inspector-port 9232" C-m

# Pane 6: ngrok
tmux select-pane -t "$SESSION_NAME:services.6" -T "ngrok → 8790"
tmux send-keys -t "$SESSION_NAME:services.6" "echo '🌐 Starting ngrok (forwarding to port 8790)...' && ngrok http 8790" C-m

# Pane 7 (bottom-right): cloud-agent-next
tmux select-pane -t "$SESSION_NAME:services.7" -T "cloud-agent-next (8794)"
tmux send-keys -t "$SESSION_NAME:services.7" "cd $PROJECT_ROOT/cloud-agent-next && echo '☁️  Starting cloud-agent-next (port 8794)...' && pnpm run dev" C-m

# Select the ngrok pane by default
tmux select-pane -t "$SESSION_NAME:services.6"

echo ""
echo "╔══════════════════════════════════════════════════════════════════╗"
echo "║            App Builder Dev Environment Started! 🚀              ║"
echo "╠══════════════════════════════════════════════════════════════════╣"
echo "║  Services:                                                       ║"
echo "║    • cloudflare-db-proxy       → http://localhost:8792          ║"
echo "║    • cloudflare-session-ingest → http://localhost:8787          ║"
echo "║    • cloud-agent               → http://localhost:8788          ║"
echo "║    • cloud-agent-next          → http://localhost:8794          ║"
echo "║    • git-token-service         → http://localhost:8795          ║"
echo "║    • cloudflare-app-builder    → http://localhost:8790          ║"
echo "║    • cloudflare-images-mcp     → http://localhost:8796          ║"
echo "║    • ngrok                     → forwarding to :8790            ║"
echo "╠══════════════════════════════════════════════════════════════════╣"
echo "║  tmux Navigation:                                                ║"
echo "║    Switch panes:  Ctrl+b then arrow keys                        ║"
echo "║    Scroll mode:   Ctrl+b then [  (use arrows/PgUp/PgDn, q=exit) ║"
echo "║    Detach:        Ctrl+b then d                                 ║"
echo "║    Zoom pane:     Ctrl+b then z  (toggle fullscreen pane)       ║"
echo "╠══════════════════════════════════════════════════════════════════╣"
echo "║  Session Commands:                                               ║"
echo "║    Attach:  tmux attach -t $SESSION_NAME                    ║"
echo "║    Kill:    tmux kill-session -t $SESSION_NAME              ║"
echo "╚══════════════════════════════════════════════════════════════════╝"
echo ""

# Attach to the session
tmux attach -t "$SESSION_NAME"
