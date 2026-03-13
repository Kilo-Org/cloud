#!/bin/bash
# Startup script for OpenClaw on Fly.io Machines
# This script:
# 1. Decrypts KILOCLAW_ENC_* environment variables (if encryption key is present)
# 2. Runs openclaw onboard --non-interactive to configure from env vars (first run only)
# 3. Patches config for features onboard doesn't cover (channels, gateway auth)
# 4. Starts the controller (which supervises the gateway)

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
# DECRYPT ENCRYPTED ENV VARS
# ============================================================
# Encrypted env vars use KILOCLAW_ENC_ prefix in config.env.
# The decryption key (KILOCLAW_ENV_KEY) is a Fly app secret
# injected at boot, never in config.env.
KILOCLAW_DECRYPT_FILE="/tmp/.kiloclaw-decrypted-env.sh"

# Fail closed: if KILOCLAW_ENC_* vars exist, KILOCLAW_ENV_KEY must be set
if env | grep -q '^KILOCLAW_ENC_' && [ -z "${KILOCLAW_ENV_KEY:-}" ]; then
    echo "FATAL: Encrypted env vars (KILOCLAW_ENC_*) found but KILOCLAW_ENV_KEY is not set"
    exit 1
fi

if [ -n "${KILOCLAW_ENV_KEY:-}" ]; then
    echo "Decrypting encrypted environment variables..."
    node << 'EOFDECRYPT'
const crypto = require('crypto');
const fs = require('fs');

const key = Buffer.from(process.env.KILOCLAW_ENV_KEY, 'base64');
const ENC_PREFIX = 'KILOCLAW_ENC_';
const VALUE_PREFIX = 'enc:v1:';
const VALID_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const lines = [];
let count = 0;

for (const [envName, value] of Object.entries(process.env)) {
    if (!envName.startsWith(ENC_PREFIX)) continue;

    const name = envName.slice(ENC_PREFIX.length);

    // Validate stripped name is a safe shell identifier
    if (!VALID_NAME.test(name)) {
        console.error('FATAL: Invalid env var name after stripping prefix: ' + name);
        process.exit(1);
    }

    // Validate value has the expected format prefix
    if (!value.startsWith(VALUE_PREFIX)) {
        console.error('FATAL: ' + envName + ' does not start with ' + VALUE_PREFIX);
        process.exit(1);
    }

    const data = Buffer.from(value.slice(VALUE_PREFIX.length), 'base64');
    const iv = data.subarray(0, 12);
    const tag = data.subarray(data.length - 16);
    const ciphertext = data.subarray(12, data.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    let plain = decipher.update(ciphertext, undefined, 'utf8');
    plain += decipher.final('utf8');

    // Shell-safe: single-quote value, escape inner single quotes
    const escaped = plain.replace(/'/g, "'\\''");
    lines.push("export " + name + "='" + escaped + "'");
    count++;
}

fs.writeFileSync('/tmp/.kiloclaw-decrypted-env.sh', lines.join('\n') + '\n');
console.log('Decrypted ' + count + ' encrypted environment variables');
EOFDECRYPT

    # Source decrypted values into shell environment, then immediately delete
    . "$KILOCLAW_DECRYPT_FILE"
    rm -f "$KILOCLAW_DECRYPT_FILE"

    # Post-decrypt presence check: critical vars must exist after decryption
    if [ -z "${KILOCODE_API_KEY:-}" ]; then
        echo "FATAL: KILOCODE_API_KEY missing after decryption"
        exit 1
    fi
    if [ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ]; then
        echo "FATAL: OPENCLAW_GATEWAY_TOKEN missing after decryption"
        exit 1
    fi

    # Clean up encryption artifacts — don't leak key material to openclaw process
    unset KILOCLAW_ENV_KEY 2>/dev/null || true
    for _enc_var in "${!KILOCLAW_ENC_@}"; do
        unset "$_enc_var"
    done
    unset _enc_var 2>/dev/null || true
else
    echo "No KILOCLAW_ENV_KEY found, using env vars as-is"
fi

# ============================================================
# ONBOARD (only if no config exists yet)
# ============================================================
if [ -z "$KILOCODE_API_KEY" ]; then
    echo "ERROR: KILOCODE_API_KEY is required"
    exit 1
fi

KILOCLAW_FRESH_INSTALL=false
if [ ! -f "$CONFIG_FILE" ]; then
    echo "No existing config found, running openclaw onboard..."

    openclaw onboard --non-interactive --accept-risk \
        --mode local \
        --gateway-port 3001 \
        --gateway-bind loopback \
        --skip-channels \
        --skip-skills \
        --skip-health \
        --kilocode-api-key "$KILOCODE_API_KEY"

    KILOCLAW_FRESH_INSTALL=true
    echo "Onboard completed"
else
    echo "Using existing config, running doctor..."
    openclaw doctor --fix --non-interactive
fi
export KILOCLAW_FRESH_INSTALL

# Seed TOOLS.md on first provision only — the bot may update it at runtime.
if [ "$KILOCLAW_FRESH_INSTALL" = "true" ]; then
    mkdir -p /root/.openclaw/workspace
    cp /usr/local/share/kiloclaw/TOOLS.md /root/.openclaw/workspace/TOOLS.md
fi

# ============================================================
# INSTANCE FEATURE FLAGS
# ============================================================
# Feature flags are owned by the DO and passed as env vars (KILOCLAW_* prefix).
# See kiloclaw/docs/instance-features.md for details.

# Feature: npm-global-prefix
# Redirect runtime `npm install -g` to the persistent volume so packages
# survive restarts. Uses /root/.npm-global instead of /usr/local.
if [ "${KILOCLAW_NPM_GLOBAL_PREFIX:-}" = "true" ]; then
    if mkdir -p /root/.npm-global/bin; then
        export NPM_CONFIG_PREFIX="/root/.npm-global"
        export PATH="$PATH:/root/.npm-global/bin"
        echo "npm global prefix set to /root/.npm-global"
    else
        echo "WARNING: failed to create npm-global directory, using default prefix"
    fi
else
    echo "npm global prefix: using default"
fi

# Feature: pip-global-prefix
# Redirect pip install --user to the persistent volume so packages
# survive restarts. Uses /root/.pip-global instead of /root/.local.
if [ "${KILOCLAW_PIP_GLOBAL_PREFIX:-}" = "true" ]; then
    if mkdir -p /root/.pip-global/bin; then
        export PYTHONUSERBASE="/root/.pip-global"
        export PATH="$PATH:/root/.pip-global/bin"
        echo "pip global prefix set to /root/.pip-global"
    else
        echo "WARNING: failed to create pip-global directory, using default prefix"
    fi
else
    echo "pip global prefix: using default"
fi

# Feature: uv-global-prefix
# Configure uv tool/cache directories on the persistent volume so
# uv tool install packages survive restarts.
if [ "${KILOCLAW_UV_GLOBAL_PREFIX:-}" = "true" ]; then
    if mkdir -p /root/.uv/tools /root/.uv/bin /root/.uv/cache; then
        export UV_TOOL_DIR="/root/.uv/tools"
        export UV_TOOL_BIN_DIR="/root/.uv/bin"
        export UV_CACHE_DIR="/root/.uv/cache"
        export PATH="$PATH:/root/.uv/bin"
        echo "uv global prefix set to /root/.uv"
    else
        echo "WARNING: failed to create uv directories, using defaults"
    fi
else
    echo "uv global prefix: using default"
fi

# Feature: kilo-cli
# Exports KILO_API_KEY so the CLI's built-in kilo provider auto-activates.
# The controller also writes /root/.config/kilo/opencode.json on fresh install
# (permissions) and patches base URL if KILOCODE_API_BASE_URL is set.
# The kilo binary is always in the image; this flag controls auto-configuration only.
if [ "${KILOCLAW_KILO_CLI:-}" = "true" ]; then
    # The Kilo CLI's KiloAuthPlugin looks for KILO_API_KEY (not KILOCODE_API_KEY).
    # Alias it so the built-in "kilo" provider auto-activates with full model access.
    if [ -n "${KILOCODE_API_KEY:-}" ]; then
        export KILO_API_KEY="$KILOCODE_API_KEY"
    fi
    echo "Kilo CLI auto-configuration enabled"
fi

# ============================================================
# GITHUB CONFIGURATION
# ============================================================
if [ -n "${GITHUB_TOKEN:-}" ]; then
    echo "Configuring GitHub access..."

    echo "$GITHUB_TOKEN" | gh auth login --with-token 2>/dev/null \
        && gh auth setup-git 2>/dev/null \
        && echo "gh CLI authenticated" \
        || echo "WARNING: gh auth login failed"

    if [ -n "${GITHUB_USERNAME:-}" ]; then
        git config --global user.name "$GITHUB_USERNAME"
        echo "git user.name set to $GITHUB_USERNAME"
    fi
    if [ -n "${GITHUB_EMAIL:-}" ]; then
        git config --global user.email "$GITHUB_EMAIL"
        echo "git user.email set to $GITHUB_EMAIL"
    fi
else
    # Clean up any previously stored credentials from the persistent volume
    # so that removing GitHub secrets actually de-authenticates the machine.
    gh auth logout --hostname github.com 2>/dev/null || true
    git config --global --unset user.name 2>/dev/null || true
    git config --global --unset user.email 2>/dev/null || true
    echo "GitHub: not configured (credentials cleared)"
fi

# ============================================================
# PATCH CONFIG (channels, gateway auth, exec policy)
# ============================================================
# openclaw onboard handles provider/model config natively (kilocode provider,
# default model, model catalog). We still need to patch in:
# - Gateway token auth
# - Channel config (Telegram, Discord, Slack)
# - Exec policy (no Docker sandbox on Fly machines)
# - Control UI settings (allowed origins, insecure auth for dev)
# - Base URL override for local dev (see note below)
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

// Migration: remove stale manually-managed kilocode provider config.
// Pre-upgrade instances have a models.providers.kilocode entry with the old
// /api/openrouter/ base URL and a flat model list (just {id, name}).
// OpenClaw 2026.2.24+ has a built-in kilocode provider with the correct
// /api/gateway/ URL and richer model definitions. Removing the stale entry
// lets the built-in provider take over. The KILOCODE_API_BASE_URL override
// below re-adds a minimal entry only when needed (local dev).
if (config.models && config.models.providers && config.models.providers.kilocode) {
    var staleBaseUrl = config.models.providers.kilocode.baseUrl || '';
    if (staleBaseUrl.includes('/api/openrouter/') || staleBaseUrl === 'https://api.kilo.ai/api/gateway/') {
        delete config.models.providers.kilocode;
        console.log('Removed stale kilocode provider config (baseUrl: ' + staleBaseUrl + ')');
        // Clean up empty providers/models objects
        if (Object.keys(config.models.providers).length === 0) {
            delete config.models.providers;
        }
        if (Object.keys(config.models).length === 0) {
            delete config.models;
        }
    }
}

config.gateway = config.gateway || {};
config.channels = config.channels || {};

// Gateway configuration
config.gateway.port = 3001;
config.gateway.mode = 'local';
// Bind to loopback only. External traffic is handled by the controller proxy.
config.gateway.bind = 'loopback';

if (process.env.OPENCLAW_GATEWAY_TOKEN) {
    config.gateway.auth = config.gateway.auth || {};
    config.gateway.auth.token = process.env.OPENCLAW_GATEWAY_TOKEN;
}

// Allow Control UI connections from localhost without WebCrypto device identity.
// This is a fallback for insecure HTTP contexts where SubtleCrypto is unavailable.
// It does NOT bypass device pairing -- pairing is handled separately via the
// controller proxy's loopback headers (auto-approve for local connections) and
// the device pairing approval UI for role-upgrade scenarios.
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

// KiloCode provider base URL override (local dev only).
// OpenClaw's native kilocode provider hardcodes https://api.kilo.ai/api/gateway/.
// In local dev, Fly machines need to route through a Cloudflare tunnel back to
// localhost, so we override the base URL when KILOCODE_API_BASE_URL is set.
// TODO: Upstream KILOCODE_API_BASE_URL env var support into OpenClaw's kilocode
// provider so this config patch can be removed entirely.
if (process.env.KILOCODE_API_BASE_URL) {
    config.models = config.models || {};
    config.models.providers = config.models.providers || {};
    config.models.providers.kilocode = config.models.providers.kilocode || {};
    config.models.providers.kilocode.baseUrl = process.env.KILOCODE_API_BASE_URL;
    // Provider entries require a models array per OpenClaw's strict zod schema.
    // Empty array is valid — the built-in kilocode provider fills in its catalog.
    config.models.providers.kilocode.models = config.models.providers.kilocode.models || [];
    console.log('Overriding kilocode base URL: ' + process.env.KILOCODE_API_BASE_URL);
}

// User-selected default model override.
// OpenClaw onboard sets kilocode/anthropic/claude-opus-4.6 as the default.
// If the user picked a different model in the UI, override it here.
if (process.env.KILOCODE_DEFAULT_MODEL) {
    config.agents = config.agents || {};
    config.agents.defaults = config.agents.defaults || {};
    config.agents.defaults.model = { primary: process.env.KILOCODE_DEFAULT_MODEL };
    console.log('Overriding default model: ' + process.env.KILOCODE_DEFAULT_MODEL);
}

// Remove the agents.defaults.models allowlist that `openclaw onboard` creates.
// When non-empty it restricts visible models to only those listed, hiding the
// rest of the kilocode catalog. KiloClaw users should see all available models.
if (config.agents && config.agents.defaults && config.agents.defaults.models) {
    delete config.agents.defaults.models;
}

// Tool profile: on fresh install, override the onboard default ("messaging")
// with "full" so agents have access to all tools. On subsequent boots,
// leave the user's choice untouched.
config.tools = config.tools || {};
if (process.env.KILOCLAW_FRESH_INSTALL === 'true') {
    config.tools.profile = 'full';
}

// Exec: KiloClaw machines have no Docker sandbox, so exec must target the
// gateway host directly. Allowlist mode gates unknown commands via the
// Control UI approval dialog; safe bins auto-allow without approval.
config.tools.exec = config.tools.exec || {};
config.tools.exec.host = 'gateway';
config.tools.exec.security = 'allowlist';
config.tools.exec.ask = 'on-miss';

// Browser: headless Chromium for the browser tool in Docker.
// OpenClaw auto-detects /usr/bin/chromium and adds --disable-dev-shm-usage on Linux.
// noSandbox is required in containers (Chromium's setuid sandbox needs kernel namespacing).
config.browser = config.browser || {};
config.browser.enabled = true;
config.browser.headless = true;
config.browser.noSandbox = true;

// Telegram configuration
// Overwrite entire channel object to drop stale keys that would fail
// OpenClaw's strict config validation (matches moltworker behavior)
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
    // openclaw onboard --skip-channels writes plugins.entries.telegram: { enabled: false }
    // which blocks the plugin from loading. Set it to true when we configure the channel.
    config.plugins = config.plugins || {};
    config.plugins.entries = config.plugins.entries || {};
    config.plugins.entries.telegram = config.plugins.entries.telegram || {};
    config.plugins.entries.telegram.enabled = true;
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
    // Enable the Discord plugin (onboard --skip-channels disables it)
    config.plugins = config.plugins || {};
    config.plugins.entries = config.plugins.entries || {};
    config.plugins.entries.discord = config.plugins.entries.discord || {};
    config.plugins.entries.discord.enabled = true;
}

// Slack configuration
if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN) {
    config.channels.slack = {
        botToken: process.env.SLACK_BOT_TOKEN,
        appToken: process.env.SLACK_APP_TOKEN,
        enabled: true,
    };
    // Enable the Slack plugin (onboard --skip-channels disables it)
    config.plugins = config.plugins || {};
    config.plugins.entries = config.plugins.entries || {};
    config.plugins.entries.slack = config.plugins.entries.slack || {};
    config.plugins.entries.slack.enabled = true;
}

fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
console.log('Configuration patched successfully');
EOFPATCH

# ============================================================
# GOG (Google Workspace CLI) KEYRING
# ============================================================
# GOG_KEYRING_PASSWORD is NOT a secret. The 99designs/keyring file backend
# requires a password to operate, but gog runs inside a single-tenant VM
# with no shared access. The value is arbitrary — it just needs to be
# consistent across setup (google-setup/setup.mjs), container startup
# (here), and runtime (controller/src/gog-credentials.ts). Without this
# env var, the keyring library prompts for a password on a missing TTY
# and fails.
export GOG_KEYRING_PASSWORD="kiloclaw"

# ============================================================
# START CONTROLLER
# ============================================================
# Tell the gateway it's running under a supervisor. On SIGUSR1 restart,
# the gateway will exit cleanly (code 0) instead of spawning a detached
# child process. The controller's supervisor detects the clean exit and
# respawns the gateway immediately without backoff.
export INVOCATION_ID=1

echo 'Starting KiloClaw controller...'

# Build gateway args as a JSON array (safe quoting through node serialization).
KILOCLAW_GATEWAY_ARGS=$(node -e "
  const args = ['--port', '3001', '--verbose', '--allow-unconfigured', '--bind', 'loopback'];
  if (process.env.OPENCLAW_GATEWAY_TOKEN) {
    args.push('--token', process.env.OPENCLAW_GATEWAY_TOKEN);
  }
  console.log(JSON.stringify(args));
")
export KILOCLAW_GATEWAY_ARGS

exec node /usr/local/bin/kiloclaw-controller.js
