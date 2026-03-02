/**
 * Generates the base openclaw.json config from environment variables.
 *
 * This is a TypeScript port of the EOFPATCH block in start-openclaw.sh.
 * Both this module and the shell script must produce identical config for the
 * same set of env vars. When updating one, update the other.
 */
import { execFileSync as nodeExecFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_CONFIG_PATH = '/root/.openclaw/openclaw.json';

export const MAX_CONFIG_BACKUPS = 5;

/** Flags passed to `openclaw onboard`, matching start-openclaw.sh. */
const ONBOARD_FLAGS = [
  'onboard',
  '--non-interactive',
  '--accept-risk',
  '--mode',
  'local',
  '--gateway-port',
  '3001',
  '--gateway-bind',
  'loopback',
  '--skip-channels',
  '--skip-skills',
  '--skip-health',
] as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ConfigObject = Record<string, any>;

type EnvLike = Record<string, string | undefined>;

type ExecFileOptions = { env?: NodeJS.ProcessEnv; stdio?: 'inherit' | 'pipe' };

export type ConfigWriterDeps = {
  readFileSync: (path: string, encoding: BufferEncoding) => string;
  writeFileSync: (path: string, data: string) => void;
  renameSync: (oldPath: string, newPath: string) => void;
  copyFileSync: (src: string, dest: string) => void;
  readdirSync: (dir: string) => string[];
  unlinkSync: (path: string) => void;
  existsSync: (path: string) => boolean;
  execFileSync: (cmd: string, args: string[], opts: ExecFileOptions) => void;
};

const defaultDeps: ConfigWriterDeps = {
  readFileSync: (p, encoding) => fs.readFileSync(p, encoding),
  writeFileSync: (p, data) => fs.writeFileSync(p, data),
  renameSync: (oldPath, newPath) => fs.renameSync(oldPath, newPath),
  copyFileSync: (src, dest) => fs.copyFileSync(src, dest),
  readdirSync: dir => fs.readdirSync(dir),
  unlinkSync: p => fs.unlinkSync(p),
  existsSync: p => fs.existsSync(p),
  execFileSync: (cmd, args, opts) => nodeExecFileSync(cmd, args, opts),
};

/**
 * Generate the base config object from environment variables.
 * Reads the existing config file (if any) as the starting point, then
 * applies all the same patches as start-openclaw.sh's EOFPATCH block.
 */
export function generateBaseConfig(
  env: EnvLike,
  configPath = DEFAULT_CONFIG_PATH,
  deps: ConfigWriterDeps = defaultDeps
): ConfigObject {
  let config: ConfigObject = {};

  try {
    const parsed: unknown = JSON.parse(deps.readFileSync(configPath, 'utf8'));
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      config = parsed as ConfigObject;
    } else {
      console.warn('Config file is not a JSON object, starting fresh');
    }
  } catch {
    console.log('Starting with empty config');
  }

  config.gateway = config.gateway ?? {};
  config.channels = config.channels ?? {};

  // Gateway configuration
  config.gateway.port = 3001;
  config.gateway.mode = 'local';
  config.gateway.bind = 'loopback';

  if (env.OPENCLAW_GATEWAY_TOKEN) {
    config.gateway.auth = config.gateway.auth ?? {};
    config.gateway.auth.token = env.OPENCLAW_GATEWAY_TOKEN;
  }

  if (env.AUTO_APPROVE_DEVICES === 'true') {
    config.gateway.controlUi = config.gateway.controlUi ?? {};
    config.gateway.controlUi.allowInsecureAuth = true;
  }

  if (env.OPENCLAW_ALLOWED_ORIGINS) {
    config.gateway.controlUi = config.gateway.controlUi ?? {};
    config.gateway.controlUi.allowedOrigins = env.OPENCLAW_ALLOWED_ORIGINS.split(',').map(s =>
      s.trim()
    );
  }

  // Migration: remove stale manually-managed kilocode provider config.
  // OpenClaw 2026.2.24+ has a built-in kilocode provider that activates when
  // KILOCODE_API_KEY is in the environment. Stale config entries with the old
  // /api/openrouter/ URL or the production /api/gateway/ URL conflict with it.
  if (config.models?.providers?.kilocode) {
    const staleBaseUrl: string = config.models.providers.kilocode.baseUrl || '';
    if (
      staleBaseUrl.includes('/api/openrouter/') ||
      staleBaseUrl === 'https://api.kilo.ai/api/gateway/'
    ) {
      delete config.models.providers.kilocode;
      console.log(`Removed stale kilocode provider config (baseUrl: ${staleBaseUrl})`);
      if (Object.keys(config.models.providers).length === 0) {
        delete config.models.providers;
      }
      if (Object.keys(config.models).length === 0) {
        delete config.models;
      }
    }
  }

  // KiloCode provider base URL override (local dev only).
  // OpenClaw's native kilocode provider hardcodes https://api.kilo.ai/api/gateway/.
  // In local dev, Fly machines need to route through a Cloudflare tunnel, so we
  // override the base URL when KILOCODE_API_BASE_URL is set.
  if (env.KILOCODE_API_BASE_URL) {
    config.models = config.models ?? {};
    config.models.providers = config.models.providers ?? {};
    config.models.providers.kilocode = config.models.providers.kilocode ?? {};
    config.models.providers.kilocode.baseUrl = env.KILOCODE_API_BASE_URL;
    // Provider entries require a models array per OpenClaw's strict zod schema.
    // Empty array is valid — the built-in kilocode provider fills in its catalog.
    config.models.providers.kilocode.models = config.models.providers.kilocode.models ?? [];
    console.log(`Overriding kilocode base URL: ${env.KILOCODE_API_BASE_URL}`);
  }

  // User-selected default model override.
  if (env.KILOCODE_DEFAULT_MODEL) {
    config.agents = config.agents ?? {};
    config.agents.defaults = config.agents.defaults ?? {};
    config.agents.defaults.model = { primary: env.KILOCODE_DEFAULT_MODEL };
    console.log(`Overriding default model: ${env.KILOCODE_DEFAULT_MODEL}`);
  }

  // Remove the agents.defaults.models allowlist that `openclaw onboard` creates.
  // When non-empty it restricts visible models to only those listed, hiding the
  // rest of the kilocode catalog. KiloClaw users should see all available models.
  if (config.agents?.defaults?.models) {
    delete config.agents.defaults.models;
  }

  // Exec tool settings
  config.tools = config.tools ?? {};
  config.tools.exec = config.tools.exec ?? {};
  config.tools.exec.host = 'gateway';
  config.tools.exec.security = 'allowlist';
  config.tools.exec.ask = 'on-miss';

  // Telegram
  if (env.TELEGRAM_BOT_TOKEN) {
    const dmPolicy = env.TELEGRAM_DM_POLICY || 'pairing';
    const telegram: ConfigObject = {
      botToken: env.TELEGRAM_BOT_TOKEN,
      enabled: true,
      dmPolicy,
    };
    if (env.TELEGRAM_DM_ALLOW_FROM) {
      telegram.allowFrom = env.TELEGRAM_DM_ALLOW_FROM.split(',');
    } else if (dmPolicy === 'open') {
      telegram.allowFrom = ['*'];
    }
    config.channels.telegram = telegram;

    config.plugins = config.plugins ?? {};
    config.plugins.entries = config.plugins.entries ?? {};
    config.plugins.entries.telegram = config.plugins.entries.telegram ?? {};
    config.plugins.entries.telegram.enabled = true;
  }

  // Discord
  if (env.DISCORD_BOT_TOKEN) {
    const dmPolicy = env.DISCORD_DM_POLICY || 'pairing';
    const dm: ConfigObject = { policy: dmPolicy };
    if (dmPolicy === 'open') {
      dm.allowFrom = ['*'];
    }
    config.channels.discord = {
      token: env.DISCORD_BOT_TOKEN,
      enabled: true,
      dm,
    };

    config.plugins = config.plugins ?? {};
    config.plugins.entries = config.plugins.entries ?? {};
    config.plugins.entries.discord = config.plugins.entries.discord ?? {};
    config.plugins.entries.discord.enabled = true;
  }

  // Slack
  if (env.SLACK_BOT_TOKEN && env.SLACK_APP_TOKEN) {
    config.channels.slack = {
      botToken: env.SLACK_BOT_TOKEN,
      appToken: env.SLACK_APP_TOKEN,
      enabled: true,
    };

    config.plugins = config.plugins ?? {};
    config.plugins.entries = config.plugins.entries ?? {};
    config.plugins.entries.slack = config.plugins.entries.slack ?? {};
    config.plugins.entries.slack.enabled = true;
  }

  return config;
}

/**
 * Generate a fresh config and write it to disk.
 *
 * Flow:
 * 1. Back up existing config to a timestamped .bak file
 * 2. Prune old backups beyond MAX_CONFIG_BACKUPS
 * 3. Run `openclaw onboard` targeting a temp file (creates a fresh, valid config
 *    without touching the existing one — if onboard fails, nothing is lost)
 * 4. Patch the fresh config with env-var-derived fields (gateway auth, channels,
 *    exec policy, dev overrides) via generateBaseConfig
 * 5. Validate the serialized JSON is parseable
 * 6. Atomically rename the temp file into place
 *
 * Returns the generated config object.
 */
export function writeBaseConfig(
  env: EnvLike,
  configPath = DEFAULT_CONFIG_PATH,
  deps: ConfigWriterDeps = defaultDeps
): ConfigObject {
  const dir = path.dirname(configPath);
  const base = path.basename(configPath);

  // 1. Back up existing config with timestamp
  if (deps.existsSync(configPath)) {
    const timestamp = new Date().toISOString().replace(/:/g, '-');
    const backupPath = path.join(dir, `${base}.bak.${timestamp}`);
    deps.copyFileSync(configPath, backupPath);
    console.log(`Backed up existing config to ${backupPath}`);
  }

  // 2. Prune old backups, keep most recent MAX_CONFIG_BACKUPS
  try {
    const backupPrefix = `${base}.bak.`;
    const backups = deps
      .readdirSync(dir)
      .filter(f => f.startsWith(backupPrefix))
      .sort();
    const toRemove = backups.slice(0, -MAX_CONFIG_BACKUPS);
    for (const old of toRemove) {
      deps.unlinkSync(path.join(dir, old));
      console.log(`Pruned old config backup: ${old}`);
    }
  } catch (error) {
    // Non-fatal — backup pruning failure shouldn't block config restore
    console.warn('Failed to prune old config backups:', error);
  }

  // 3. Run `openclaw onboard` targeting a temp file so the existing (possibly
  //    broken) config is untouched until we're ready to atomically swap in.
  const tmpPath = path.join(dir, `.${base}.kilotmp.${crypto.randomBytes(6).toString('hex')}`);
  try {
    const apiKey = env.KILOCODE_API_KEY;
    if (!apiKey) {
      throw new Error('KILOCODE_API_KEY is required for config restore');
    }

    console.log('Running openclaw onboard to generate fresh config...');
    // Spread the full process env (needed for PATH, HOME, etc.) with the
    // config path override. The API key is passed as a CLI flag, not env var.
    deps.execFileSync('openclaw', [...ONBOARD_FLAGS, '--kilocode-api-key', apiKey], {
      env: { ...process.env, OPENCLAW_CONFIG_PATH: tmpPath },
      stdio: 'inherit',
    });
    console.log('Onboard completed, patching config...');

    // 4. Patch the fresh onboard config with env-var-derived fields
    const config = generateBaseConfig(env, tmpPath, deps);

    // 5. Serialize and validate roundtrip
    const serialized = JSON.stringify(config, null, 2);
    JSON.parse(serialized); // belt-and-suspenders: should never fail

    // 6. Write patched config to the temp file, then atomically rename into place
    deps.writeFileSync(tmpPath, serialized);
    deps.renameSync(tmpPath, configPath);

    console.log('Configuration restored successfully');
    return config;
  } catch (error) {
    // Clean up the temp file so we don't leak partial writes
    try {
      deps.unlinkSync(tmpPath);
    } catch {
      // Best-effort cleanup — the dotfile prefix keeps it hidden at least
    }
    throw error;
  }
}
