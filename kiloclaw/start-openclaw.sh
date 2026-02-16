#!/bin/bash
# Startup script for OpenClaw on Fly.io Machines
# This script:
# 1. Runs openclaw onboard --non-interactive to configure from env vars (first run only)
# 2. Patches config for features onboard doesn't cover (channels, gateway auth)
# 3. Starts the gateway

set -e

if pgrep -f "openclaw gateway" > /dev/null 2>&1; then
    echo "OpenClaw gateway is already running, exiting."
    exit 0
fi

CONFIG_DIR="/root/.openclaw"
CONFIG_FILE="$CONFIG_DIR/openclaw.json"
WORKSPACE_DIR="/root/clawd"

echo "Config directory: $CONFIG_DIR"

mkdir -p "$CONFIG_DIR"
mkdir -p "$WORKSPACE_DIR"
cd "$WORKSPACE_DIR"

# ============================================================
# ONBOARD (only if no config exists yet)
# ============================================================
if [ -z "$KILOCODE_API_KEY" ]; then
    echo "ERROR: KILOCODE_API_KEY is required"
    exit 1
fi

if [ ! -f "$CONFIG_FILE" ]; then
    echo "No existing config found, running openclaw onboard..."

    openclaw onboard --non-interactive --accept-risk \
        --mode local \
        --gateway-port 18789 \
        --gateway-bind lan \
        --skip-channels \
        --skip-skills \
        --skip-health

    echo "Onboard completed"
else
    echo "Using existing config"
fi

# ============================================================
# PATCH CONFIG (channels, gateway auth, trusted proxies)
# ============================================================
# openclaw onboard handles provider/model config, but we need to patch in:
# - Channel config (Telegram, Discord, Slack)
# - Gateway token auth
# - KiloCode provider + model config
node << 'EOFPATCH'
const fs = require('fs');

const configPath = '/root/.openclaw/openclaw.json';
console.log('Patching config at:', configPath);
let config = {};

try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (e) {
    console.log('Starting with empty config');
}

config.gateway = config.gateway || {};
config.channels = config.channels || {};

// Gateway configuration
config.gateway.port = 18789;
config.gateway.mode = 'local';
// Set bind to loopback so agent tools connect via 127.0.0.1 (auto-approved for pairing).
// The actual server bind is controlled by --bind lan on the command line, not this config.
config.gateway.bind = 'loopback';

if (process.env.OPENCLAW_GATEWAY_TOKEN) {
    config.gateway.auth = config.gateway.auth || {};
    config.gateway.auth.token = process.env.OPENCLAW_GATEWAY_TOKEN;
}

if (process.env.OPENCLAW_DEV_MODE === 'true') {
    config.gateway.controlUi = config.gateway.controlUi || {};
    config.gateway.controlUi.allowInsecureAuth = true;
}

// Multi-tenant: auto-approve devices so users don't need to pair.
// Worker-level JWT auth is the real access control -- each user's machine
// is only reachable via their signed token.
if (process.env.AUTO_APPROVE_DEVICES === 'true') {
    config.gateway.controlUi = config.gateway.controlUi || {};
    config.gateway.controlUi.allowInsecureAuth = true;
}

// Allowed origins for the Control UI WebSocket.
// Without this, the gateway rejects connections from browser origins
// that don't match the gateway's Host header (e.g., localhost:3000 vs fly.dev).
if (process.env.OPENCLAW_ALLOWED_ORIGINS) {
    config.gateway.controlUi = config.gateway.controlUi || {};
    config.gateway.controlUi.allowedOrigins = process.env.OPENCLAW_ALLOWED_ORIGINS
        .split(',')
        .map(function(s) { return s.trim(); });
}

// KiloCode provider configuration (required)
const providerName = 'kilocode';
const baseUrl = process.env.KILOCODE_API_BASE_URL || 'https://api.kilo.ai/api/openrouter/';
const defaultModel =
    process.env.KILOCODE_DEFAULT_MODEL || providerName + '/anthropic/claude-opus-4.5';
const modelsPath = '/root/.openclaw/kilocode-models.json';
const defaultModels = [
    { id: 'anthropic/claude-opus-4.5', name: 'Anthropic: Claude Opus 4.5' },
    { id: 'minimax/minimax-m2.1:free', name: 'Minimax: Minimax M2.1' },
    { id: 'z-ai/glm-4.7:free', name: 'GLM-4.7 (Free - Exclusive to Kilo)' },
];
let models = defaultModels;

// Prefer KILOCODE_MODELS_JSON env var (set by buildEnvVars from DO config).
// Falls back to file-based override for manual use, then baked-in defaults.
if (process.env.KILOCODE_MODELS_JSON) {
    try {
        const parsed = JSON.parse(process.env.KILOCODE_MODELS_JSON);
        models = Array.isArray(parsed) ? parsed : defaultModels;
        console.log('Using model list from KILOCODE_MODELS_JSON (' + models.length + ' models)');
    } catch (error) {
        console.warn('Failed to parse KILOCODE_MODELS_JSON, using defaults:', error);
    }
} else if (fs.existsSync(modelsPath)) {
    const rawModels = fs.readFileSync(modelsPath, 'utf8');
    if (rawModels.trim().length === 0) {
        models = [];
    } else {
        try {
            const parsed = JSON.parse(rawModels);
            models = Array.isArray(parsed) ? parsed : [];
        } catch (error) {
            console.warn('Failed to parse KiloCode models file, using empty list:', error);
            models = [];
        }
    }
}

config.models = config.models || {};
config.models.providers = config.models.providers || {};
config.models.providers[providerName] = {
    baseUrl: baseUrl,
    apiKey: process.env.KILOCODE_API_KEY,
    api: 'openai-completions',
    models: models,
};

config.agents = config.agents || {};
config.agents.defaults = config.agents.defaults || {};
config.agents.defaults.model = { primary: defaultModel };
console.log('KiloCode provider configured with base URL ' + baseUrl);

// Explicitly lock down exec tool security (defense-in-depth).
// OpenClaw defaults to these values, but pinning them here prevents
// silent regression if upstream defaults change in a future version.
config.tools = config.tools || {};
config.tools.exec = config.tools.exec || {};
config.tools.exec.security = 'deny';
config.tools.exec.ask = 'on-miss';

// Telegram configuration
if (process.env.TELEGRAM_BOT_TOKEN) {
    const dmPolicy = process.env.TELEGRAM_DM_POLICY || 'pairing';
    config.channels.telegram = {
        botToken: process.env.TELEGRAM_BOT_TOKEN,
        enabled: true,
        dmPolicy: dmPolicy,
    };
    if (process.env.TELEGRAM_DM_ALLOW_FROM) {
        config.channels.telegram.allowFrom = process.env.TELEGRAM_DM_ALLOW_FROM.split(',');
    } else if (dmPolicy === 'open') {
        config.channels.telegram.allowFrom = ['*'];
    }
}

// Discord configuration
if (process.env.DISCORD_BOT_TOKEN) {
    const dmPolicy = process.env.DISCORD_DM_POLICY || 'pairing';
    const dm = { policy: dmPolicy };
    if (dmPolicy === 'open') {
        dm.allowFrom = ['*'];
    }
    config.channels.discord = {
        token: process.env.DISCORD_BOT_TOKEN,
        enabled: true,
        dm: dm,
    };
}

// Slack configuration
if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN) {
    config.channels.slack = {
        botToken: process.env.SLACK_BOT_TOKEN,
        appToken: process.env.SLACK_APP_TOKEN,
        enabled: true,
    };
}

fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
console.log('Configuration patched successfully');
EOFPATCH

# ============================================================
# START GATEWAY
# ============================================================
echo "Starting OpenClaw Gateway..."
echo "Gateway will be available on port 18789"

rm -f /tmp/openclaw-gateway.lock 2>/dev/null || true
rm -f "$CONFIG_DIR/gateway.lock" 2>/dev/null || true

echo "Dev mode: ${OPENCLAW_DEV_MODE:-false}"

if [ -n "$OPENCLAW_GATEWAY_TOKEN" ]; then
    echo "Starting gateway with token auth..."
    exec openclaw gateway --port 18789 --verbose --allow-unconfigured --bind lan --token "$OPENCLAW_GATEWAY_TOKEN"
else
    echo "Starting gateway with device pairing (no token)..."
    exec openclaw gateway --port 18789 --verbose --allow-unconfigured --bind lan
fi
