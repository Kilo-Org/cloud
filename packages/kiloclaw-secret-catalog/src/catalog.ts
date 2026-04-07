import { z } from 'zod';
import type { SecretCatalogEntry, SecretCategory } from './types';
import { SecretCatalogEntrySchema } from './types';

/**
 * Secret Catalog — declarative registry of all secret types.
 *
 * Migrated from cloud/src/app/(app)/claw/components/channel-config.tsx
 *
 * Uses `as const satisfies` to preserve literal IDs/keys/env-vars for
 * precise TypeScript unions, while Zod validates the structure at runtime.
 */
const SECRET_CATALOG_RAW = [
  {
    id: 'telegram',
    label: 'Telegram',
    category: 'channel',
    icon: 'send',
    order: 1,
    fields: [
      {
        key: 'telegramBotToken',
        label: 'Bot Token',
        placeholder: '123456:ABC-DEF...',
        placeholderConfigured: 'Enter new token to replace',
        envVar: 'TELEGRAM_BOT_TOKEN',
        validationPattern: '^\\d{8,}:[A-Za-z0-9_-]{30,50}$',
        validationMessage:
          'Telegram tokens look like 123456789:ABCDefGhIJKlmn... (digits, colon, then letters/numbers).',
        maxLength: 100,
      },
    ],
    helpText: 'Get a token from @BotFather on Telegram.',
    helpUrl: 'https://t.me/BotFather',
  },
  {
    id: 'discord',
    label: 'Discord',
    category: 'channel',
    icon: 'discord',
    order: 2,
    fields: [
      {
        key: 'discordBotToken',
        label: 'Bot Token',
        placeholder: 'MTIz...',
        placeholderConfigured: 'Enter new token to replace',
        envVar: 'DISCORD_BOT_TOKEN',
        // Note: {24,}? uses lazy quantifier (preserved from original channel-config.tsx).
        // With ^...$ anchors, lazy vs greedy doesn't affect correctness, only backtracking.
        validationPattern: '^[A-Za-z\\d_-]{24,}?\\.[A-Za-z\\d_-]{4,}\\.[A-Za-z\\d_-]{25,}$',
        validationMessage:
          'Discord tokens have three dot-separated parts, like MTIz...abc.XYZ123.abcdef...',
        maxLength: 200,
      },
    ],
    helpText: 'Get a token from the Discord Developer Portal.',
    helpUrl: 'https://discord.com/developers/applications',
  },
  {
    id: 'slack',
    label: 'Slack',
    category: 'channel',
    icon: 'slack',
    order: 3,
    allFieldsRequired: true,
    fields: [
      {
        key: 'slackBotToken',
        label: 'Bot Token',
        placeholder: 'xoxb-...',
        placeholderConfigured: 'Enter new bot token to replace',
        envVar: 'SLACK_BOT_TOKEN',
        validationPattern: '^xoxb-[A-Za-z0-9-]{20,255}$',
        validationMessage: 'Slack bot tokens start with xoxb- (not xoxp- or xapp-).',
        maxLength: 300,
      },
      {
        key: 'slackAppToken',
        label: 'App Token',
        placeholder: 'xapp-...',
        placeholderConfigured: 'Enter new app token to replace',
        envVar: 'SLACK_APP_TOKEN',
        validationPattern: '^xapp-[A-Za-z0-9-]{20,255}$',
        validationMessage: 'Slack app tokens start with xapp- (not xoxb- or xoxp-).',
        maxLength: 300,
      },
    ],
    helpText: 'Get tokens from Slack App Management. Both Bot Token and App Token are required.',
    helpUrl: 'https://api.slack.com/apps',
  },
  {
    id: 'github',
    label: 'GitHub',
    category: 'tool',
    icon: 'github',
    order: 1,
    allFieldsRequired: true,
    fields: [
      {
        key: 'githubUsername',
        label: 'Username',
        placeholder: 'my-bot-user',
        placeholderConfigured: 'Enter new username to replace',
        envVar: 'GITHUB_USERNAME',
        validationPattern: '^[a-zA-Z\\d](?:[a-zA-Z\\d]|-(?=[a-zA-Z\\d])){0,38}$',
        validationMessage:
          'GitHub usernames can only contain alphanumeric characters and hyphens, and cannot start or end with a hyphen.',
        maxLength: 39,
      },
      {
        key: 'githubEmail',
        label: 'Email',
        placeholder: 'bot@example.com',
        placeholderConfigured: 'Enter new email to replace',
        envVar: 'GITHUB_EMAIL',
        validationPattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$',
        validationMessage: 'Enter a valid email address.',
        maxLength: 254,
      },
      {
        key: 'githubToken',
        label: 'Personal Access Token',
        placeholder: 'github_pat_...',
        placeholderConfigured: 'Enter new token to replace',
        envVar: 'GITHUB_TOKEN',
        validationPattern: '^(ghp_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})$',
        validationMessage:
          'Personal access tokens only: classic (ghp_) or fine-grained (github_pat_). OAuth and Actions tokens are not supported.',
        maxLength: 300,
      },
    ],
    helpText: 'Manage your token from the GitHub developer settings.',
    helpUrl: 'https://github.com/settings/tokens?type=beta',
  },
  {
    id: 'agentcard',
    label: 'AgentCard',
    category: 'tool',
    icon: 'credit-card',
    order: 2,
    fields: [
      {
        key: 'agentcardApiKey',
        label: 'API Key (JWT)',
        placeholder: 'eyJ...',
        placeholderConfigured: 'Enter new JWT to replace',
        envVar: 'AGENTCARD_API_KEY',
        validationPattern: '^eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$',
        validationMessage: 'Enter the JWT from ~/.agent-cards/config.json (starts with eyJ).',
        maxLength: 2000,
      },
    ],
    helpText: 'Virtual debit cards for autonomous agent spending. See setup guide for details.',
    helpUrl: 'https://agentcard.sh',
  },
  {
    id: 'onepassword',
    label: '1Password',
    category: 'tool',
    icon: 'lock',
    order: 3,
    fields: [
      {
        key: 'onepasswordServiceAccountToken',
        label: 'Service Account Token',
        placeholder: 'ops_...',
        placeholderConfigured: 'Enter new token to replace',
        envVar: 'OP_SERVICE_ACCOUNT_TOKEN',
        validationPattern: '^ops_[A-Za-z0-9_\\-]{50,1500}$',
        validationMessage:
          '1Password service account tokens start with ops_ followed by a long base64-encoded string.',
        maxLength: 2000,
      },
    ],
    helpText: 'Create a service account at 1password.com with access to a dedicated vault.',
    helpUrl: 'https://developer.1password.com/docs/service-accounts/get-started/',
  },
  {
    id: 'brave-search',
    label: 'Brave Search',
    category: 'tool',
    icon: 'brave',
    order: 4,
    fields: [
      {
        key: 'braveSearchApiKey',
        label: 'API Key',
        placeholder: 'BSA...',
        placeholderConfigured: 'Enter new key to replace',
        envVar: 'BRAVE_API_KEY',
        validationPattern: '^BSA[A-Za-z0-9_-]{20,}$',
        validationMessage: 'Brave Search keys start with BSA followed by 20 or more characters.',
        maxLength: 200,
      },
    ],
    helpText: 'Get an API key from the Brave Search dashboard.',
    helpUrl: 'https://brave.com/search/api/',
  },
  {
    id: 'linear',
    label: 'Linear',
    category: 'tool',
    icon: 'linear',
    order: 5,
    fields: [
      {
        key: 'linearApiKey',
        label: 'API Key',
        placeholder: 'lin_api_...',
        placeholderConfigured: 'Enter new API key to replace',
        envVar: 'LINEAR_API_KEY',
        validationPattern: '^lin_api_[a-zA-Z0-9]{40}$',
        validationMessage:
          'Linear API keys start with lin_api_ followed by 40 alphanumeric characters.',
        maxLength: 100,
      },
    ],
    helpText: 'Generate an API key from your Linear account security settings.',
    helpUrl: 'https://linear.app/settings/account/security',
  },
] as const satisfies readonly SecretCatalogEntry[];

// Runtime validation — fails fast at module load if catalog data is malformed
export const SECRET_CATALOG: readonly SecretCatalogEntry[] = z
  .array(SecretCatalogEntrySchema)
  .readonly()
  .parse(SECRET_CATALOG_RAW);

// Lookup helpers

/** Map of entry ID → entry */
export const SECRET_CATALOG_MAP: ReadonlyMap<string, SecretCatalogEntry> = new Map(
  SECRET_CATALOG.map(entry => [entry.id, entry])
);

/** Union type of all secret field keys in the catalog */
export type SecretFieldKey = (typeof SECRET_CATALOG_RAW)[number]['fields'][number]['key'];

/** Set of all field keys across all entries */
export const ALL_SECRET_FIELD_KEYS: ReadonlySet<string> = new Set(
  SECRET_CATALOG.flatMap(entry => entry.fields.map(field => field.key))
);

/** Map of field key → env var name */
export const FIELD_KEY_TO_ENV_VAR: ReadonlyMap<string, string> = new Map(
  SECRET_CATALOG.flatMap(entry => entry.fields.map(field => [field.key, field.envVar]))
);

/** Reverse map: env var name → field key (for reading encryptedSecrets back to working set) */
export const ENV_VAR_TO_FIELD_KEY: ReadonlyMap<string, string> = new Map(
  SECRET_CATALOG.flatMap(entry => entry.fields.map(field => [field.envVar, field.key]))
);

/** Map of field key → owning entry (used for allFieldsRequired checks) */
export const FIELD_KEY_TO_ENTRY: ReadonlyMap<string, SecretCatalogEntry> = new Map(
  SECRET_CATALOG.flatMap(entry => entry.fields.map(field => [field.key, entry]))
);

/** Largest maxLength across all catalog fields (for blanket Zod schema caps) */
export const MAX_SECRET_FIELD_LENGTH: number = Math.max(
  ...SECRET_CATALOG.flatMap(entry => entry.fields.map(field => field.maxLength))
);

/** Set of all env var names from catalog entries (for SENSITIVE_KEYS classification) */
export const ALL_SECRET_ENV_VARS: ReadonlySet<string> = new Set(
  SECRET_CATALOG.flatMap(entry => entry.fields.map(field => field.envVar))
);

/**
 * Env vars that are always sensitive but aren't part of the UI catalog.
 * These are set internally by the worker (e.g. from encrypted DO state),
 * not entered by users through the secret management UI.
 */
export const INTERNAL_SENSITIVE_ENV_VARS: ReadonlySet<string> = new Set([
  'KILOCLAW_GOG_CONFIG_TARBALL',
]);

/**
 * Get all entries for a given category, sorted by order (undefined sorts last).
 */
export function getEntriesByCategory(category: SecretCategory): SecretCatalogEntry[] {
  return SECRET_CATALOG.filter(entry => entry.category === category).sort((a, b) => {
    const orderA = a.order ?? Number.MAX_SAFE_INTEGER;
    const orderB = b.order ?? Number.MAX_SAFE_INTEGER;
    return orderA - orderB;
  });
}

/**
 * Get the set of all field keys for a given category.
 * Allocates a new Set on each call — cache the result if used in a hot path.
 */
export function getFieldKeysByCategory(category: SecretCategory): ReadonlySet<string> {
  return new Set(
    SECRET_CATALOG.filter(e => e.category === category).flatMap(e => e.fields.map(f => f.key))
  );
}

// --- Custom (non-catalog) secret helpers ---

/** Maximum number of custom secrets a single instance can store. */
export const MAX_CUSTOM_SECRETS = 50;

/** Maximum value length for custom secrets (covers JWTs, certificates). */
export const MAX_CUSTOM_SECRET_VALUE_LENGTH = 8192;

const CUSTOM_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Env var name prefixes that are reserved for system use and cannot be
 * set by users as custom secret env var names.
 */
const DENIED_ENV_VAR_PREFIXES: readonly string[] = [
  'KILOCLAW_',
  'OPENCLAW_',
  'KILOCODE_',
  'FLY_',
  'NEXTAUTH_',
  'NODE_',
  'STREAM_CHAT_',
];

/**
 * Exact env var names that are reserved for system use.
 * Includes OS/shell vars, runtime vars, and vars we explicitly set
 * in the env var build pipeline.
 */
const DENIED_ENV_VAR_NAMES: ReadonlySet<string> = new Set([
  // OS / shell
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'TERM',
  'LANG',
  'HOSTNAME',
  'PWD',
  'TMPDIR',
  'TZ',
  // KiloClaw managed (set by buildEnvVars or controller)
  'AUTO_APPROVE_DEVICES',
  'REQUIRE_PROXY_TOKEN',
  'INVOCATION_ID',
  'TELEGRAM_DM_POLICY',
  'DISCORD_DM_POLICY',
]);

/**
 * Check whether a key is a valid custom (non-catalog) secret env var name.
 *
 * Custom keys must:
 * - Be a valid shell identifier
 * - Not collide with a catalog field key or catalog env var name
 * - Not be on the deny list (system-reserved prefixes or exact names)
 * - Be at most 128 characters
 */
export function isValidCustomSecretKey(key: string): boolean {
  if (ALL_SECRET_FIELD_KEYS.has(key)) return false;
  if (ALL_SECRET_ENV_VARS.has(key)) return false;
  if (key.length === 0 || key.length > 128) return false;
  if (!CUSTOM_KEY_RE.test(key)) return false;
  if (DENIED_ENV_VAR_NAMES.has(key)) return false;
  for (const prefix of DENIED_ENV_VAR_PREFIXES) {
    if (key.startsWith(prefix)) return false;
  }
  return true;
}

/**
 * Check whether an env var name stored in encryptedSecrets is a custom
 * (non-catalog, non-internal) secret. Used to filter the custom secret
 * list out of the full encryptedSecrets record.
 */
export function isCustomSecretEnvVar(envVarName: string): boolean {
  return !ALL_SECRET_ENV_VARS.has(envVarName) && !INTERNAL_SENSITIVE_ENV_VARS.has(envVarName);
}

// --- Config path helpers ---

// Allows hyphens in segments for header keys (x-api-key) and channel names (nextcloud-talk).
const CONFIG_PATH_RE = /^[a-zA-Z_][a-zA-Z0-9_-]*(\.[a-zA-Z_][a-zA-Z0-9_-]*)*$/;
const MAX_CONFIG_PATH_LENGTH = 256;

/**
 * OpenClaw supported SecretRef path patterns (from openclaw/src/secrets/target-registry-data.ts).
 * Wildcard `*` matches any single path segment (e.g. "models.providers.*.apiKey"
 * matches "models.providers.openai.apiKey").
 *
 * Only openclaw.json paths are included — auth-profiles.json paths (profiles.*.key,
 * profiles.*.token) target a different file and require separate handling.
 */
const ALLOWED_CONFIG_PATH_PATTERNS: readonly string[] = [
  // Agents
  'agents.defaults.memorySearch.remote.apiKey',
  // agents.list[].memorySearch.remote.apiKey omitted: array-indexed paths
  // can't be expressed in dot notation and CONFIG_PATH_RE rejects brackets.
  // Channels — BlueBubbles
  'channels.bluebubbles.password',
  'channels.bluebubbles.accounts.*.password',
  // Channels — Discord (channels.discord.token omitted: catalog-managed)
  'channels.discord.pluralkit.token',
  'channels.discord.voice.tts.providers.*.apiKey',
  'channels.discord.accounts.*.token',
  'channels.discord.accounts.*.pluralkit.token',
  'channels.discord.accounts.*.voice.tts.providers.*.apiKey',
  // Channels — Feishu
  'channels.feishu.appSecret',
  'channels.feishu.encryptKey',
  'channels.feishu.verificationToken',
  'channels.feishu.accounts.*.appSecret',
  'channels.feishu.accounts.*.encryptKey',
  'channels.feishu.accounts.*.verificationToken',
  // Channels — Google Chat (sibling_ref shape — omitted, requires special handling)
  // Channels — IRC
  'channels.irc.password',
  'channels.irc.nickserv.password',
  'channels.irc.accounts.*.password',
  'channels.irc.accounts.*.nickserv.password',
  // Channels — Mattermost
  'channels.mattermost.botToken',
  'channels.mattermost.accounts.*.botToken',
  // Channels — Matrix
  'channels.matrix.password',
  'channels.matrix.accounts.*.password',
  // Channels — MS Teams
  'channels.msteams.appPassword',
  // Channels — Nextcloud Talk
  'channels.nextcloud-talk.botSecret',
  'channels.nextcloud-talk.apiPassword',
  'channels.nextcloud-talk.accounts.*.botSecret',
  'channels.nextcloud-talk.accounts.*.apiPassword',
  // Channels — Slack (botToken/appToken omitted: catalog-managed)
  'channels.slack.userToken',
  'channels.slack.signingSecret',
  'channels.slack.accounts.*.botToken',
  'channels.slack.accounts.*.appToken',
  'channels.slack.accounts.*.userToken',
  'channels.slack.accounts.*.signingSecret',
  // Channels — Telegram (channels.telegram.botToken omitted: catalog-managed)
  'channels.telegram.webhookSecret',
  'channels.telegram.accounts.*.botToken',
  'channels.telegram.accounts.*.webhookSecret',
  // Channels — Zalo
  'channels.zalo.botToken',
  'channels.zalo.webhookSecret',
  'channels.zalo.accounts.*.botToken',
  'channels.zalo.accounts.*.webhookSecret',
  // Cron
  'cron.webhookToken',
  // Gateway — omitted: KiloClaw-managed (overwritten by generateBaseConfig on every boot)
  // Messages
  'messages.tts.providers.*.apiKey',
  // Models
  'models.providers.*.apiKey',
  'models.providers.*.headers.*',
  // Skills
  'skills.entries.*.apiKey',
  // Talk
  'talk.apiKey',
  'talk.providers.*.apiKey',
  // Tools — Web
  'tools.web.fetch.firecrawl.apiKey',
  'tools.web.search.apiKey',
  'tools.web.search.gemini.apiKey',
  'tools.web.search.grok.apiKey',
  'tools.web.search.kimi.apiKey',
  'tools.web.search.perplexity.apiKey',
  // Plugins
  'plugins.entries.brave.config.webSearch.apiKey',
  'plugins.entries.google.config.webSearch.apiKey',
  'plugins.entries.xai.config.webSearch.apiKey',
  'plugins.entries.moonshot.config.webSearch.apiKey',
  'plugins.entries.perplexity.config.webSearch.apiKey',
  'plugins.entries.firecrawl.config.webSearch.apiKey',
  'plugins.entries.tavily.config.webSearch.apiKey',
];

/**
 * Config paths denied even though they're in OpenClaw's registry.
 * Includes paths managed by KiloClaw and OpenClaw's excluded credentials.
 */
const DENIED_CONFIG_PATHS: ReadonlySet<string> = new Set([
  // KiloClaw-managed: gateway auth (overwritten by generateBaseConfig on every boot)
  'gateway.auth.token',
  'gateway.auth.password',
  'gateway.remote.token',
  'gateway.remote.password',
  // KiloClaw-managed: catalog secrets (use the dedicated Settings UI sections)
  'channels.telegram.botToken',
  'channels.discord.token',
  'channels.slack.botToken',
  'channels.slack.appToken',
  // OpenClaw excluded: mutable or runtime-managed credentials
  'commands.ownerDisplaySecret',
  'channels.matrix.accessToken',
  'hooks.token',
  'hooks.gmail.pushToken',
]);

/**
 * Denied config path patterns (with wildcards) from OpenClaw's excluded list.
 */
const DENIED_CONFIG_PATH_PATTERNS: readonly string[] = [
  'channels.matrix.accounts.*.accessToken',
  'hooks.mappings[].sessionKey',
  'discord.threadBindings.*.webhookToken',
];

/**
 * Check whether a concrete config path matches a pattern with `*` wildcards.
 * Each `*` matches exactly one path segment.
 * `[]` in patterns matches any segment (for array notation).
 */
function matchesPattern(path: string, pattern: string): boolean {
  const pathParts = path.split('.');
  const patternParts = pattern.split('.');
  if (pathParts.length !== patternParts.length) return false;
  return patternParts.every((part, i) => part === '*' || part === pathParts[i]);
}

/**
 * Check whether a config path is valid for custom secrets.
 *
 * Must match one of OpenClaw's supported SecretRef path patterns and
 * must not be on the deny list (KiloClaw-managed or OpenClaw-excluded).
 */
export function isValidConfigPath(path: string): boolean {
  if (path.length === 0 || path.length > MAX_CONFIG_PATH_LENGTH) return false;
  if (!CONFIG_PATH_RE.test(path)) return false;

  // Check deny list (exact matches)
  if (DENIED_CONFIG_PATHS.has(path)) return false;

  // Check deny list (pattern matches)
  for (const pattern of DENIED_CONFIG_PATH_PATTERNS) {
    if (matchesPattern(path, pattern)) return false;
  }

  // Must match at least one allowed pattern
  return ALLOWED_CONFIG_PATH_PATTERNS.some(pattern => matchesPattern(path, pattern));
}

/**
 * Return all allowed config path patterns for UI display (e.g. autocomplete).
 */
export function getAllowedConfigPathPatterns(): readonly string[] {
  return ALLOWED_CONFIG_PATH_PATTERNS;
}
