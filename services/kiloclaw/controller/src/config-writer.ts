/**
 * Generates the base openclaw.json config from environment variables.
 *
 * Config patching for openclaw.json — channels, gateway auth, exec policy, etc.
 * Both this module and the shell script must produce identical config for the
 * same set of env vars. When updating one, update the other.
 */
import { execFileSync as nodeExecFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_CONFIG_PATH = '/root/.openclaw/openclaw.json';

export const MAX_CONFIG_BACKUPS = 5;

// NOTE: writeBaseConfig does NOT use the shared atomicWrite utility because
// the temp file is created earlier by `openclaw onboard` and shared across
// multiple steps (onboard writes to it, generateBaseConfig reads from it,
// then we write the patched content and rename into place). atomicWrite
// manages its own temp file internally, so it cannot participate in this
// lifecycle.

function pruneOldConfigBackups(dir: string, base: string, deps: ConfigWriterDeps): void {
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
    // Non-fatal — backup pruning failure shouldn't block config writes
    console.warn('Failed to prune old config backups:', error);
  }
}

/** Flags passed to `openclaw onboard` for non-interactive first-boot setup. */
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

const KILOCLAW_CUSTOMIZER_PLUGIN_ID = 'kiloclaw-customizer';
const KILOCLAW_CUSTOMIZER_PLUGIN_PATH = '/usr/local/lib/node_modules/@kiloclaw/kiloclaw-customizer';
const KILO_EXA_PROVIDER_ID = 'kilo-exa';

type KiloExaSearchMode = 'kilo-proxy' | 'disabled';

type KiloExaSearchModeState = KiloExaSearchMode | 'unset';

function resolveKiloExaSearchMode(value: string | undefined): KiloExaSearchModeState {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'kilo-proxy') {
    return 'kilo-proxy';
  }
  if (normalized === 'disabled') {
    return 'disabled';
  }
  if (normalized === undefined || normalized === '') {
    return 'unset';
  }
  console.warn(`Unknown KILO_EXA_SEARCH_MODE value "${value}"; treating as "disabled"`);
  return 'disabled';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ConfigObject = Record<string, any>;

type EnvLike = Record<string, string | undefined>;

const INBOUND_EMAIL_HOOK_MAPPING = {
  id: 'cloudflare-email-inbound',
  match: { path: 'email' },
  action: 'wake',
  wakeMode: 'now',
  name: 'Inbound Email',
  sessionKey: '{{payload.sessionKey}}',
  messageTemplate: 'From: {{payload.from}}\nSubject: {{payload.subject}}\n\n{{payload.text}}',
  deliver: false,
};

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
 * applies all env-var-derived patches (channels, gateway auth, exec policy, etc.).
 */
export function generateBaseConfig(
  env: EnvLike,
  configPath = DEFAULT_CONFIG_PATH,
  deps: ConfigWriterDeps = defaultDeps
): ConfigObject {
  let config: ConfigObject = {};

  try {
    const raw = deps.readFileSync(configPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      config = parsed as ConfigObject;
    } else {
      console.warn('Config file is not a JSON object, starting fresh');
    }
  } catch (err) {
    // If the file exists but can't be parsed, that's unexpected — openclaw
    // doctor just ran against it, or writeBaseConfig just wrote it. Throwing
    // here prevents silent data loss (wiping user customizations like channels,
    // plugins, model preferences) by falling through to an empty config.
    // On the onboard path this catch is hit when there's no file at all,
    // which is fine — but we distinguish by checking if the file exists.
    if (deps.existsSync(configPath)) {
      throw new Error(
        `Failed to parse existing config at ${configPath}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    console.log('No existing config file, starting with empty config');
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
  // For the production /api/gateway/ URL, skip removal when KILOCODE_ORGANIZATION_ID
  // is set: org-scoped instances need an explicit provider entry (with the production
  // baseUrl) to carry the org header. The /api/openrouter/ cleanup always runs since
  // that URL is unconditionally broken.
  if (config.models?.providers?.kilocode) {
    const staleBaseUrl: string = config.models.providers.kilocode.baseUrl || '';
    const isOpenrouterUrl = staleBaseUrl.includes('/api/openrouter/');
    const isGatewayUrl = staleBaseUrl === 'https://api.kilo.ai/api/gateway/';
    if (isOpenrouterUrl || (isGatewayUrl && !env.KILOCODE_ORGANIZATION_ID)) {
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

  // Pass org scope to KiloCode provider as request header when available.
  // This is used by OpenClaw provider requests (not Kilo CLI).
  // Header name matches ORGANIZATION_ID_HEADER in src/lib/constants.ts.
  if (env.KILOCODE_ORGANIZATION_ID) {
    config.models = config.models ?? {};
    config.models.providers = config.models.providers ?? {};
    config.models.providers.kilocode = config.models.providers.kilocode ?? {};
    // Explicit provider entries require a baseUrl per OpenClaw's strict schema.
    // When KILOCODE_API_BASE_URL already set the URL above, preserve it;
    // otherwise default to the production gateway URL.
    config.models.providers.kilocode.baseUrl =
      config.models.providers.kilocode.baseUrl ?? 'https://api.kilo.ai/api/gateway/';
    config.models.providers.kilocode.headers = config.models.providers.kilocode.headers ?? {};
    config.models.providers.kilocode.headers['X-KiloCode-OrganizationId'] =
      env.KILOCODE_ORGANIZATION_ID;
    config.models.providers.kilocode.models = config.models.providers.kilocode.models ?? [];
    console.log('Configured KiloCode organization header from KILOCODE_ORGANIZATION_ID');
  } else {
    // Remove stale org header from previous boots (e.g., instance was transferred
    // from org to personal, or org was deleted).
    delete config.models?.providers?.kilocode?.headers?.['X-KiloCode-OrganizationId'];
  }

  // User-selected default model override.
  if (env.KILOCODE_DEFAULT_MODEL) {
    config.agents = config.agents ?? {};
    config.agents.defaults = config.agents.defaults ?? {};
    config.agents.defaults.model = config.agents.defaults.model ?? {};
    config.agents.defaults.model.primary = env.KILOCODE_DEFAULT_MODEL;
    console.log(`Overriding default model: ${env.KILOCODE_DEFAULT_MODEL}`);
  }

  // Remove the agents.defaults.models allowlist that `openclaw onboard` creates.
  // When non-empty it restricts visible models to only those listed, hiding the
  // rest of the kilocode catalog. KiloClaw users should see all available models.
  if (config.agents?.defaults?.models) {
    delete config.agents.defaults.models;
  }

  // Tool profile: on fresh install, override the onboard default "messaging"
  // with "full" so agents have all tools. Also backfill to "full" when the
  // profile field is missing. On subsequent boots, leave user's explicit
  // profile choice untouched.
  config.tools = config.tools ?? {};
  if (env.KILOCLAW_FRESH_INSTALL === 'true' || !config.tools.profile) {
    config.tools.profile = 'full';
  }

  // Exec: KiloClaw machines have no Docker sandbox, so exec must target the
  // gateway host directly. Security and ask are user-configurable via the
  // provisioning preset, persisted in DO state and transported as env vars.
  // Defaults match the 'always-ask' preset (allowlist + on-miss).
  config.tools.exec = config.tools.exec ?? {};
  config.tools.exec.host = 'gateway';
  config.tools.exec.security = env.KILOCLAW_EXEC_SECURITY || 'allowlist';
  config.tools.exec.ask = env.KILOCLAW_EXEC_ASK || 'on-miss';

  // Disable update checks on start. KiloClaw manages updates via Docker
  // image deployments, not openclaw's built-in updater.
  config.update = config.update ?? {};
  config.update.checkOnStart = false;

  // Browser: headless Chromium for the browser tool in Docker.
  // OpenClaw auto-detects /usr/bin/chromium and adds --disable-dev-shm-usage on Linux.
  // noSandbox is required in containers (Chromium's setuid sandbox needs kernel namespacing).
  config.browser = config.browser ?? {};
  config.browser.enabled = true;
  config.browser.headless = true;
  config.browser.noSandbox = true;

  // KiloClaw customizer plugin
  // Always load/enable this plugin so KiloClaw identity behavior is consistent
  // across first boot and subsequent restarts.
  config.plugins = config.plugins ?? {};
  config.plugins.load = config.plugins.load ?? {};
  config.plugins.load.paths = Array.isArray(config.plugins.load.paths)
    ? config.plugins.load.paths
    : [];
  if (!(config.plugins.load.paths as string[]).includes(KILOCLAW_CUSTOMIZER_PLUGIN_PATH)) {
    (config.plugins.load.paths as string[]).push(KILOCLAW_CUSTOMIZER_PLUGIN_PATH);
  }
  config.plugins.entries = config.plugins.entries ?? {};
  config.plugins.entries[KILOCLAW_CUSTOMIZER_PLUGIN_ID] =
    config.plugins.entries[KILOCLAW_CUSTOMIZER_PLUGIN_ID] ?? {};
  config.plugins.entries[KILOCLAW_CUSTOMIZER_PLUGIN_ID].enabled = true;

  const customizerPluginConfig = config.plugins.entries[KILOCLAW_CUSTOMIZER_PLUGIN_ID].config ?? {};
  const customizerWebSearchConfig = customizerPluginConfig.webSearch ?? {};
  const searchProvider = config.tools?.web?.search?.provider;
  const hasExplicitSearchProvider =
    typeof searchProvider === 'string' && searchProvider.trim().length > 0;

  const kiloExaSearchMode = resolveKiloExaSearchMode(env.KILO_EXA_SEARCH_MODE);
  const shouldForceExa = kiloExaSearchMode === 'kilo-proxy';
  const shouldAutoAssignExa = kiloExaSearchMode === 'unset' && !hasExplicitSearchProvider;
  if (shouldForceExa || shouldAutoAssignExa) {
    customizerWebSearchConfig.enabled = true;
    config.tools = config.tools ?? {};
    config.tools.web = config.tools.web ?? {};
    config.tools.web.search = config.tools.web.search ?? {};
    config.tools.web.search.enabled = true;
    config.tools.web.search.provider = KILO_EXA_PROVIDER_ID;
    if (shouldAutoAssignExa) {
      console.log('[config-writer] Auto-assigned web search provider to kilo-exa (mode=unset)');
    }
  } else if (kiloExaSearchMode === 'disabled') {
    customizerWebSearchConfig.enabled = false;

    const braveConfigured = Boolean(env.BRAVE_API_KEY?.trim());
    if (
      braveConfigured &&
      (!hasExplicitSearchProvider || config.tools?.web?.search?.provider === KILO_EXA_PROVIDER_ID)
    ) {
      config.tools = config.tools ?? {};
      config.tools.web = config.tools.web ?? {};
      config.tools.web.search = config.tools.web.search ?? {};
      config.tools.web.search.enabled = true;
      config.tools.web.search.provider = 'brave';
    } else if (config.tools?.web?.search?.provider === KILO_EXA_PROVIDER_ID) {
      delete config.tools.web.search.provider;
    }
  } else if (hasExplicitSearchProvider) {
    customizerWebSearchConfig.enabled =
      config.tools?.web?.search?.provider === KILO_EXA_PROVIDER_ID;
  }

  customizerPluginConfig.webSearch = customizerWebSearchConfig;
  config.plugins.entries[KILOCLAW_CUSTOMIZER_PLUGIN_ID].config = customizerPluginConfig;

  // Telegram
  if (env.TELEGRAM_BOT_TOKEN) {
    const dmPolicy = env.TELEGRAM_DM_POLICY || 'pairing';
    config.channels.telegram = config.channels.telegram ?? {};
    config.channels.telegram.botToken = env.TELEGRAM_BOT_TOKEN;
    config.channels.telegram.enabled = true;
    config.channels.telegram.dmPolicy = dmPolicy;
    // Explicit env override always wins; otherwise only seed allowFrom on
    // first boot (when the key is absent) so user edits are preserved.
    if (env.TELEGRAM_DM_ALLOW_FROM) {
      config.channels.telegram.allowFrom = env.TELEGRAM_DM_ALLOW_FROM.split(',');
    } else if (!('allowFrom' in config.channels.telegram)) {
      config.channels.telegram.allowFrom = dmPolicy === 'open' ? ['*'] : [];
    }

    config.plugins = config.plugins ?? {};
    config.plugins.entries = config.plugins.entries ?? {};
    config.plugins.entries.telegram = config.plugins.entries.telegram ?? {};
    config.plugins.entries.telegram.enabled = true;
  }

  // Discord
  if (env.DISCORD_BOT_TOKEN) {
    const dmPolicy = env.DISCORD_DM_POLICY || 'pairing';
    config.channels.discord = config.channels.discord ?? {};
    config.channels.discord.token = env.DISCORD_BOT_TOKEN;
    config.channels.discord.enabled = true;
    config.channels.discord.dm = config.channels.discord.dm ?? {};
    config.channels.discord.dm.policy = dmPolicy;
    // Only seed allowFrom on first boot so user edits are preserved.
    if (!('allowFrom' in config.channels.discord.dm)) {
      config.channels.discord.dm.allowFrom = dmPolicy === 'open' ? ['*'] : [];
    }

    config.plugins = config.plugins ?? {};
    config.plugins.entries = config.plugins.entries ?? {};
    config.plugins.entries.discord = config.plugins.entries.discord ?? {};
    config.plugins.entries.discord.enabled = true;
  }

  // Slack
  if (env.SLACK_BOT_TOKEN && env.SLACK_APP_TOKEN) {
    config.channels.slack = config.channels.slack ?? {};
    config.channels.slack.botToken = env.SLACK_BOT_TOKEN;
    config.channels.slack.appToken = env.SLACK_APP_TOKEN;
    config.channels.slack.enabled = true;

    config.plugins = config.plugins ?? {};
    config.plugins.entries = config.plugins.entries ?? {};
    config.plugins.entries.slack = config.plugins.entries.slack ?? {};
    config.plugins.entries.slack.enabled = true;
  }

  // Stream Chat default channel (auto-provisioned at provision time)
  if (env.STREAM_CHAT_API_KEY && env.STREAM_CHAT_BOT_USER_ID && env.STREAM_CHAT_BOT_USER_TOKEN) {
    config.channels.streamchat = config.channels.streamchat ?? {};
    config.channels.streamchat.apiKey = env.STREAM_CHAT_API_KEY;
    config.channels.streamchat.botUserId = env.STREAM_CHAT_BOT_USER_ID;
    config.channels.streamchat.botUserToken = env.STREAM_CHAT_BOT_USER_TOKEN;
    config.channels.streamchat.botUserName = 'KiloClaw';
    config.channels.streamchat.enabled = true;

    config.plugins = config.plugins ?? {};
    config.plugins.load = config.plugins.load ?? {};
    config.plugins.load.paths = Array.isArray(config.plugins.load.paths)
      ? config.plugins.load.paths
      : [];
    const pluginPath = '/usr/local/lib/node_modules/@wunderchat/openclaw-channel-streamchat';
    if (!(config.plugins.load.paths as string[]).includes(pluginPath)) {
      (config.plugins.load.paths as string[]).push(pluginPath);
    }

    config.plugins.entries = config.plugins.entries ?? {};
    // Entry key must match the plugin's manifest id (openclaw.plugin.json).
    // The fork's manifest declares id "openclaw-channel-streamchat" to align
    // with the idHint that OpenClaw derives from the package name.
    const scEntry = 'openclaw-channel-streamchat';
    config.plugins.entries[scEntry] = config.plugins.entries[scEntry] ?? {};
    config.plugins.entries[scEntry].enabled = true;
  }

  // Webhook hooks configuration for controller-mediated inbound events.
  // hooks.token stays local to the machine; external Workers authenticate to
  // controller endpoints with the gateway token instead.
  if (env.KILOCLAW_HOOKS_TOKEN) {
    config.hooks = config.hooks ?? {};
    config.hooks.enabled = true;
    config.hooks.token = env.KILOCLAW_HOOKS_TOKEN;
    config.hooks.path = '/hooks';

    config.hooks.mappings = Array.isArray(config.hooks.mappings) ? config.hooks.mappings : [];
    const existingEmailMappingIndex = config.hooks.mappings.findIndex(
      (mapping: ConfigObject) => mapping.id === INBOUND_EMAIL_HOOK_MAPPING.id
    );
    if (existingEmailMappingIndex === -1) {
      config.hooks.mappings.push(INBOUND_EMAIL_HOOK_MAPPING);
    } else {
      config.hooks.mappings[existingEmailMappingIndex] = INBOUND_EMAIL_HOOK_MAPPING;
    }

    if (env.KILOCLAW_GOG_CONFIG_TARBALL) {
      config.hooks.presets = config.hooks.presets ?? [];
      if (!Array.isArray(config.hooks.presets)) {
        config.hooks.presets = [];
      }
      if (!(config.hooks.presets as string[]).includes('gmail')) {
        (config.hooks.presets as string[]).push('gmail');
      }
    }
    console.log('Hooks enabled with inbound email mapping (dedicated token)');
  }

  // Custom secret config path patching — set decrypted secret values at
  // user-specified JSON dot-notation paths in openclaw.json.
  if (env.KILOCLAW_SECRET_CONFIG_PATHS) {
    try {
      const pathMap: Record<string, string> = JSON.parse(env.KILOCLAW_SECRET_CONFIG_PATHS);
      for (const [envVar, configPath] of Object.entries(pathMap)) {
        const value = env[envVar];
        if (value) {
          setNestedValue(config, configPath, value);
          console.log(`Patched custom secret ${envVar} → ${configPath}`);
        }
      }
    } catch (err) {
      console.warn('Failed to parse KILOCLAW_SECRET_CONFIG_PATHS:', err);
    }
  }

  return config;
}

/**
 * Set a value at a dot-notation path in a nested object, creating
 * intermediate objects as needed.
 * e.g. setNestedValue(obj, "models.providers.openai.apiKey", "sk-...")
 */
const BANNED_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

export function setNestedValue(obj: ConfigObject, path: string, value: string): void {
  const segments = path.split('.');
  for (const seg of segments) {
    if (BANNED_SEGMENTS.has(seg)) {
      console.warn(`Refusing to patch ${path}: "${seg}" is a banned path segment`);
      return;
    }
  }
  let current = obj;
  for (let i = 0; i < segments.length - 1; i++) {
    const existing = current[segments[i]];
    if (existing != null && (typeof existing !== 'object' || Array.isArray(existing))) {
      console.warn(
        `Cannot patch ${path}: "${segments.slice(0, i + 1).join('.')}" is not an object`
      );
      return;
    }
    current[segments[i]] = existing ?? {};
    current = current[segments[i]] as ConfigObject;
  }
  current[segments[segments.length - 1]] = value;
}

export const DEFAULT_MCPORTER_CONFIG_PATH = '/root/.openclaw/workspace/config/mcporter.json';

/**
 * Write mcporter.json with MCP server definitions derived from environment variables.
 * MCPorter is the middleware layer that lets OpenClaw agents call MCP server tools
 * via `mcporter call <server>.<tool>`.
 *
 * The `config.mcp.servers` schema exists in openclaw.json (since v2026.3.14), but
 * OpenClaw's embedded Pi MCP runtime only supports StdioClientTransport — it has no
 * HTTP/SSE transport. Since our MCP servers (AgentCard, Linear) are remote HTTP
 * endpoints, mcporter must stay until OpenClaw adds HTTP transport support.
 *
 * TODO: When OpenClaw's Pi MCP bridge gains HTTP/SSE transport, migrate these
 * definitions into generateBaseConfig() using `config.mcp.servers` and remove
 * mcporter.
 */
export function writeMcporterConfig(
  env: EnvLike,
  configPath = DEFAULT_MCPORTER_CONFIG_PATH,
  deps: ConfigWriterDeps = defaultDeps
): void {
  // Read existing config to preserve user-added servers
  let existing: Record<string, unknown> = {};
  try {
    const raw = deps.readFileSync(configPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>;
    }
  } catch {
    // No existing config or unreadable — start fresh
  }

  const existingServers =
    typeof existing.mcpServers === 'object' && existing.mcpServers !== null
      ? { ...(existing.mcpServers as Record<string, unknown>) }
      : {};

  // Managed server keys — add when env var is set, remove when absent.
  // This ensures credential removal on the dashboard actually revokes access
  // even though mcporter.json persists on the volume across restarts.
  if (env.AGENTCARD_API_KEY) {
    existingServers['agentcard'] = {
      url: 'https://mcp.agentcard.sh/mcp',
      headers: { Authorization: 'Bearer ' + env.AGENTCARD_API_KEY },
    };
    console.log('AgentCard MCP server configured (via mcporter)');
  } else {
    if ('agentcard' in existingServers) {
      delete existingServers['agentcard'];
      console.log('AgentCard MCP server removed from mcporter config');
    }
  }

  if (env.LINEAR_API_KEY) {
    existingServers['linear'] = {
      url: 'https://mcp.linear.app/mcp',
      headers: { Authorization: 'Bearer ${LINEAR_API_KEY}' },
    };
    console.log('Linear MCP server configured (via mcporter)');
  } else {
    if ('linear' in existingServers) {
      delete existingServers['linear'];
      console.log('Linear MCP server removed from mcporter config');
    }
  }

  // Only write if there are servers to configure or we need to clean up
  if (Object.keys(existingServers).length === 0 && !deps.existsSync(configPath)) {
    return;
  }

  existing.mcpServers = existingServers;

  const dir = path.dirname(configPath);
  if (!deps.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  deps.writeFileSync(configPath, JSON.stringify(existing, null, 2));
  console.log(`mcporter config written to ${configPath}`);
}

/**
 * Back up the existing config file and prune old backups.
 */
export function backupConfigFile(
  configPath = DEFAULT_CONFIG_PATH,
  deps: ConfigWriterDeps = defaultDeps
): void {
  const dir = path.dirname(configPath);
  const base = path.basename(configPath);

  if (deps.existsSync(configPath)) {
    const timestamp = new Date().toISOString().replace(/:/g, '-');
    const backupPath = path.join(dir, `${base}.bak.${timestamp}`);
    deps.copyFileSync(configPath, backupPath);
    console.log(`Backed up existing config to ${backupPath}`);
  }

  pruneOldConfigBackups(dir, base, deps);
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
  backupConfigFile(configPath, deps);

  const dir = path.dirname(configPath);
  const base = path.basename(configPath);

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

    // 4. Patch the fresh onboard config with env-var-derived fields.
    const config = generateBaseConfig(env, tmpPath, deps);
    // Restore flow should still force full tools profile even when
    // KILOCLAW_FRESH_INSTALL is not set.
    config.tools = config.tools ?? {};
    config.tools.profile = 'full';

    // 5. Serialize and validate roundtrip
    const serialized = JSON.stringify(config, null, 2);
    JSON.parse(serialized); // belt-and-suspenders: should never fail

    // 6. Write patched config to the temp file, then atomically rename into place
    deps.writeFileSync(tmpPath, serialized);
    deps.renameSync(tmpPath, configPath);

    console.log('Configuration patched successfully');
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
