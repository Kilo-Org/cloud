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
  'GOOGLE_GOG_CONFIG_TARBALL',
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
