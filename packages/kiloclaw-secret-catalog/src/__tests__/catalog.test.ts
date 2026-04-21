import { describe, it, expect } from 'vitest';
import {
  SECRET_CATALOG,
  SECRET_CATALOG_MAP,
  ALL_SECRET_FIELD_KEYS,
  FIELD_KEY_TO_ENV_VAR,
  ENV_VAR_TO_FIELD_KEY,
  FIELD_KEY_TO_ENTRY,
  ALL_SECRET_ENV_VARS,
  INTERNAL_SENSITIVE_ENV_VARS,
  getEntriesByCategory,
  getFieldKeysByCategory,
  isValidCustomSecretKey,
  isCustomSecretEnvVar,
  isValidConfigPath,
  MAX_CUSTOM_SECRETS,
  MAX_CUSTOM_SECRET_VALUE_LENGTH,
} from '../catalog.js';
import { validateFieldValue } from '../validation.js';
import type { SecretIconKey, SecretCatalogEntry } from '../types.js';
import { DEFAULT_INJECTION_METHOD, getInjectionMethod } from '../types.js';

describe('Secret Catalog', () => {
  describe('Uniqueness constraints', () => {
    it('all entry IDs are unique', () => {
      const ids = SECRET_CATALOG.map(e => e.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });

    it('all field keys are unique across entries', () => {
      const keys = SECRET_CATALOG.flatMap(e => e.fields.map(f => f.key));
      const uniqueKeys = new Set(keys);
      expect(uniqueKeys.size).toBe(keys.length);
    });

    it('all env var names are unique across entries', () => {
      const envVars = SECRET_CATALOG.flatMap(e => e.fields.map(f => f.envVar));
      expect(new Set(envVars).size).toBe(envVars.length);
    });
  });

  describe('Icon validation', () => {
    it('all icon values are valid SecretIconKey members', () => {
      const validIcons: Set<SecretIconKey> = new Set([
        'send',
        'discord',
        'slack',
        'key',
        'github',
        'linear',
        'credit-card',
        'lock',
        'brave',
      ]);
      for (const entry of SECRET_CATALOG) {
        expect(validIcons.has(entry.icon)).toBe(true);
      }
    });
  });

  describe('Field constraints', () => {
    it('all fields have explicit maxLength', () => {
      for (const entry of SECRET_CATALOG) {
        for (const field of entry.fields) {
          expect(field.maxLength, `${entry.id}.${field.key} missing maxLength`).toBeDefined();
        }
      }
    });
  });

  describe('Validation patterns', () => {
    it('all validation patterns compile as valid regex', () => {
      for (const entry of SECRET_CATALOG) {
        for (const field of entry.fields) {
          if (field.validationPattern) {
            const pattern = field.validationPattern;
            expect(() => new RegExp(pattern)).not.toThrow();
          }
        }
      }
    });

    it('no validation pattern exhibits catastrophic backtracking', { timeout: 1000 }, () => {
      // ReDoS-prone patterns blow up on near-match inputs (long valid prefix + invalid suffix),
      // not on completely unrelated strings like 'aaa...'. Test both cases.
      const evilSuffixes = ['!', '\x00', ' '];
      const longRepeats = [
        'a'.repeat(10000),
        'A'.repeat(10000),
        '1'.repeat(10000),
        'xoxb-' + 'A'.repeat(10000),
        'xapp-' + 'A'.repeat(10000),
        '1234567890:' + 'A'.repeat(10000),
      ];

      for (const entry of SECRET_CATALOG) {
        for (const field of entry.fields) {
          if (field.validationPattern) {
            const regex = new RegExp(field.validationPattern);

            // Test completely unrelated long input
            for (const input of longRepeats) {
              expect(typeof regex.test(input)).toBe('boolean');
            }

            // Test near-match: long valid-ish prefix + invalid suffix
            for (const input of longRepeats) {
              for (const suffix of evilSuffixes) {
                expect(typeof regex.test(input + suffix)).toBe('boolean');
              }
            }
          }
        }
      }
    });
  });

  describe('Field to env var mappings', () => {
    it('FIELD_KEY_TO_ENV_VAR covers all known channel env vars', () => {
      const knownEnvVars = new Set([
        'TELEGRAM_BOT_TOKEN',
        'DISCORD_BOT_TOKEN',
        'SLACK_BOT_TOKEN',
        'SLACK_APP_TOKEN',
        'GITHUB_TOKEN',
        'GITHUB_USERNAME',
        'GITHUB_EMAIL',
        'BRAVE_API_KEY',
        'LINEAR_API_KEY',
      ]);

      const catalogEnvVars = new Set(FIELD_KEY_TO_ENV_VAR.values());

      for (const envVar of knownEnvVars) {
        expect(catalogEnvVars.has(envVar)).toBe(true);
      }
    });

    it('FIELD_KEY_TO_ENV_VAR has correct mappings', () => {
      expect(FIELD_KEY_TO_ENV_VAR.get('telegramBotToken')).toBe('TELEGRAM_BOT_TOKEN');
      expect(FIELD_KEY_TO_ENV_VAR.get('discordBotToken')).toBe('DISCORD_BOT_TOKEN');
      expect(FIELD_KEY_TO_ENV_VAR.get('slackBotToken')).toBe('SLACK_BOT_TOKEN');
      expect(FIELD_KEY_TO_ENV_VAR.get('slackAppToken')).toBe('SLACK_APP_TOKEN');
      expect(FIELD_KEY_TO_ENV_VAR.get('githubToken')).toBe('GITHUB_TOKEN');
      expect(FIELD_KEY_TO_ENV_VAR.get('githubUsername')).toBe('GITHUB_USERNAME');
      expect(FIELD_KEY_TO_ENV_VAR.get('githubEmail')).toBe('GITHUB_EMAIL');
      expect(FIELD_KEY_TO_ENV_VAR.get('braveSearchApiKey')).toBe('BRAVE_API_KEY');
    });

    it('ENV_VAR_TO_FIELD_KEY is the exact reverse of FIELD_KEY_TO_ENV_VAR', () => {
      expect(ENV_VAR_TO_FIELD_KEY.size).toBe(FIELD_KEY_TO_ENV_VAR.size);
      for (const [fieldKey, envVar] of FIELD_KEY_TO_ENV_VAR) {
        expect(ENV_VAR_TO_FIELD_KEY.get(envVar)).toBe(fieldKey);
      }
    });

    it('ENV_VAR_TO_FIELD_KEY has correct reverse mappings', () => {
      expect(ENV_VAR_TO_FIELD_KEY.get('TELEGRAM_BOT_TOKEN')).toBe('telegramBotToken');
      expect(ENV_VAR_TO_FIELD_KEY.get('DISCORD_BOT_TOKEN')).toBe('discordBotToken');
      expect(ENV_VAR_TO_FIELD_KEY.get('SLACK_BOT_TOKEN')).toBe('slackBotToken');
      expect(ENV_VAR_TO_FIELD_KEY.get('SLACK_APP_TOKEN')).toBe('slackAppToken');
      expect(ENV_VAR_TO_FIELD_KEY.get('GITHUB_TOKEN')).toBe('githubToken');
      expect(ENV_VAR_TO_FIELD_KEY.get('GITHUB_USERNAME')).toBe('githubUsername');
      expect(ENV_VAR_TO_FIELD_KEY.get('GITHUB_EMAIL')).toBe('githubEmail');
      expect(ENV_VAR_TO_FIELD_KEY.get('BRAVE_API_KEY')).toBe('braveSearchApiKey');
    });
  });

  describe('Lookup helpers', () => {
    it('SECRET_CATALOG_MAP contains all entries by ID', () => {
      expect(SECRET_CATALOG_MAP.size).toBe(SECRET_CATALOG.length);
      for (const entry of SECRET_CATALOG) {
        expect(SECRET_CATALOG_MAP.get(entry.id)).toBe(entry);
      }
    });

    it('ALL_SECRET_FIELD_KEYS contains all field keys', () => {
      const expectedKeys = SECRET_CATALOG.flatMap(e => e.fields.map(f => f.key));
      expect(ALL_SECRET_FIELD_KEYS.size).toBe(expectedKeys.length);
      for (const key of expectedKeys) {
        expect(ALL_SECRET_FIELD_KEYS.has(key)).toBe(true);
      }
    });

    it('FIELD_KEY_TO_ENTRY maps field keys to owning entries', () => {
      expect(FIELD_KEY_TO_ENTRY.get('telegramBotToken')?.id).toBe('telegram');
      expect(FIELD_KEY_TO_ENTRY.get('discordBotToken')?.id).toBe('discord');
      expect(FIELD_KEY_TO_ENTRY.get('slackBotToken')?.id).toBe('slack');
      expect(FIELD_KEY_TO_ENTRY.get('slackAppToken')?.id).toBe('slack');
      expect(FIELD_KEY_TO_ENTRY.get('githubToken')?.id).toBe('github');
      expect(FIELD_KEY_TO_ENTRY.get('githubUsername')?.id).toBe('github');
      expect(FIELD_KEY_TO_ENTRY.get('githubEmail')?.id).toBe('github');
    });
  });

  describe('getEntriesByCategory', () => {
    it('returns all channel entries sorted by order', () => {
      const channels = getEntriesByCategory('channel');
      expect(channels.length).toBe(3);
      expect(channels[0].id).toBe('telegram');
      expect(channels[1].id).toBe('discord');
      expect(channels[2].id).toBe('slack');
    });

    it('returns all tool entries sorted by order', () => {
      const tools = getEntriesByCategory('tool');
      expect(tools.length).toBe(5);
      expect(tools[0].id).toBe('github');
      expect(tools[1].id).toBe('agentcard');
      expect(tools[2].id).toBe('onepassword');
      expect(tools[3].id).toBe('brave-search');
      expect(tools[4].id).toBe('linear');
    });

    it('returns empty array for categories with no entries', () => {
      const providers = getEntriesByCategory('provider');
      expect(providers).toEqual([]);
    });
  });

  describe('getFieldKeysByCategory', () => {
    it('returns all channel field keys', () => {
      const keys = getFieldKeysByCategory('channel');
      expect(keys).toContain('telegramBotToken');
      expect(keys).toContain('discordBotToken');
      expect(keys).toContain('slackBotToken');
      expect(keys).toContain('slackAppToken');
      expect(keys.size).toBe(4);
    });

    it('returns all tool field keys', () => {
      const keys = getFieldKeysByCategory('tool');
      expect(keys).toContain('githubToken');
      expect(keys).toContain('githubUsername');
      expect(keys).toContain('githubEmail');
      expect(keys).toContain('linearApiKey');
      expect(keys).toContain('agentcardApiKey');
      expect(keys).toContain('onepasswordServiceAccountToken');
      expect(keys).toContain('braveSearchApiKey');
      expect(keys.size).toBe(7);
    });

    it('returns empty set for categories with no entries', () => {
      const keys = getFieldKeysByCategory('provider');
      expect(keys.size).toBe(0);
    });
  });

  describe('getInjectionMethod', () => {
    const baseEntry: SecretCatalogEntry = {
      id: 'test',
      label: 'Test',
      category: 'channel',
      icon: 'key',
      fields: [],
    };

    it('returns env as default when injectionMethod is undefined', () => {
      expect(getInjectionMethod(baseEntry)).toBe('env');
      expect(DEFAULT_INJECTION_METHOD).toBe('env');
    });

    it('returns explicit injectionMethod when set', () => {
      const entry: SecretCatalogEntry = { ...baseEntry, injectionMethod: 'openclaw-secrets' };
      expect(getInjectionMethod(entry)).toBe('openclaw-secrets');
    });

    it('all current catalog entries use default injection method', () => {
      for (const entry of SECRET_CATALOG) {
        expect(getInjectionMethod(entry)).toBe('env');
      }
    });
  });

  describe('validateFieldValue', () => {
    it('accepts valid Telegram tokens', () => {
      const pattern = '^\\d{8,}:[A-Za-z0-9_-]{30,50}$';
      expect(validateFieldValue('123456789:ABCDefGhIJKlmnOPQrstUVWXYZ123456', pattern)).toBe(true);
    });

    it('rejects invalid Telegram tokens', () => {
      const pattern = '^\\d{8,}:[A-Za-z0-9_-]{30,50}$';
      expect(validateFieldValue('invalid', pattern)).toBe(false);
      expect(validateFieldValue('123:short', pattern)).toBe(false);
    });

    it('accepts valid Discord tokens', () => {
      const pattern = '^[A-Za-z\\d_-]{24,}?\\.[A-Za-z\\d_-]{4,}\\.[A-Za-z\\d_-]{25,}$';
      expect(
        validateFieldValue(
          'MTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM.ABCD.abcdefghijklmnopqrstuvwxyz',
          pattern
        )
      ).toBe(true);
    });

    it('rejects invalid Discord tokens', () => {
      const pattern = '^[A-Za-z\\d_-]{24,}?\\.[A-Za-z\\d_-]{4,}\\.[A-Za-z\\d_-]{25,}$';
      expect(validateFieldValue('invalid', pattern)).toBe(false);
      expect(validateFieldValue('short.ab.cd', pattern)).toBe(false);
    });

    it('accepts valid Slack bot tokens', () => {
      const pattern = '^xoxb-[A-Za-z0-9-]{20,255}$';
      // Use clearly fake token to avoid GitHub push protection false positives
      expect(validateFieldValue('xoxb-FAKE-TEST-TOKEN-abcdefghijklmnopqrst', pattern)).toBe(true);
    });

    it('rejects invalid Slack bot tokens', () => {
      const pattern = '^xoxb-[A-Za-z0-9-]{20,255}$';
      expect(validateFieldValue('xoxp-invalid', pattern)).toBe(false);
      expect(validateFieldValue('xoxb-short', pattern)).toBe(false);
    });

    it('accepts valid Slack app tokens', () => {
      const pattern = '^xapp-[A-Za-z0-9-]{20,255}$';
      // Use clearly fake token to avoid GitHub push protection false positives
      expect(validateFieldValue('xapp-FAKE-TEST-TOKEN-abcdefghijklmnopqrst', pattern)).toBe(true);
    });

    it('rejects invalid Slack app tokens', () => {
      const pattern = '^xapp-[A-Za-z0-9-]{20,255}$';
      expect(validateFieldValue('xoxb-invalid', pattern)).toBe(false);
      expect(validateFieldValue('xapp-short', pattern)).toBe(false);
    });

    it('accepts valid GitHub usernames', () => {
      const pattern = '^[a-zA-Z\\d](?:[a-zA-Z\\d]|-(?=[a-zA-Z\\d])){0,38}$';
      expect(validateFieldValue('octocat', pattern)).toBe(true);
      expect(validateFieldValue('my-bot-user', pattern)).toBe(true);
      expect(validateFieldValue('a', pattern)).toBe(true);
      expect(validateFieldValue('User123', pattern)).toBe(true);
    });

    it('rejects invalid GitHub usernames', () => {
      const pattern = '^[a-zA-Z\\d](?:[a-zA-Z\\d]|-(?=[a-zA-Z\\d])){0,38}$';
      expect(validateFieldValue('-octocat', pattern)).toBe(false);
      expect(validateFieldValue('octocat-', pattern)).toBe(false);
      expect(validateFieldValue('my--name', pattern)).toBe(false);
      expect(validateFieldValue('my_name', pattern)).toBe(false);
      expect(validateFieldValue('user name', pattern)).toBe(false);
    });

    it('accepts valid email addresses', () => {
      const pattern = '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$';
      expect(validateFieldValue('bot@example.com', pattern)).toBe(true);
      expect(validateFieldValue('my-bot@my-org.io', pattern)).toBe(true);
    });

    it('rejects invalid email addresses', () => {
      const pattern = '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$';
      expect(validateFieldValue('notanemail', pattern)).toBe(false);
      expect(validateFieldValue('missing@domain', pattern)).toBe(false);
      expect(validateFieldValue('has space@example.com', pattern)).toBe(false);
    });

    it('accepts valid GitHub classic tokens (ghp_)', () => {
      const pattern = '^(ghp_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})$';
      expect(validateFieldValue('ghp_' + 'A'.repeat(36), pattern)).toBe(true);
      expect(validateFieldValue('ghp_' + 'abcDEF123456'.repeat(5), pattern)).toBe(true);
    });

    it('accepts valid GitHub fine-grained tokens (github_pat_)', () => {
      const pattern = '^(ghp_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})$';
      expect(validateFieldValue('github_pat_' + 'A'.repeat(22), pattern)).toBe(true);
      expect(validateFieldValue('github_pat_' + 'abc_DEF_123'.repeat(5), pattern)).toBe(true);
    });

    it('rejects invalid GitHub tokens', () => {
      const pattern = '^(ghp_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})$';
      expect(validateFieldValue('ghp_short', pattern)).toBe(false);
      expect(validateFieldValue('github_pat_short', pattern)).toBe(false);
      expect(validateFieldValue('gho_invalidprefix', pattern)).toBe(false);
      expect(validateFieldValue('invalid', pattern)).toBe(false);
    });

    it('accepts valid Brave Search API keys', () => {
      const pattern = '^BSA[A-Za-z0-9_-]{20,}$';
      // Real key format: BSA + mixed alphanumeric, ~30 chars total
      expect(validateFieldValue('BSAq2h7cYupyy704DHyXPFlUx8SinqK', pattern)).toBe(true);
      expect(validateFieldValue('BSA' + 'A'.repeat(20), pattern)).toBe(true);
      expect(validateFieldValue('BSAIabcDEF_123-456abcDEF1234', pattern)).toBe(true);
    });

    it('rejects invalid Brave Search API keys', () => {
      const pattern = '^BSA[A-Za-z0-9_-]{20,}$';
      expect(validateFieldValue('invalid', pattern)).toBe(false);
      expect(validateFieldValue('BSAshort', pattern)).toBe(false);
      expect(validateFieldValue('bsa' + 'A'.repeat(20), pattern)).toBe(false);
    });

    it('rejects empty strings', () => {
      const pattern = '^\\d{8,}:[A-Za-z0-9_-]{30,50}$';
      expect(validateFieldValue('', pattern)).toBe(false);
    });

    it('accepts null (no validation needed)', () => {
      const pattern = '^\\d{8,}:[A-Za-z0-9_-]{30,50}$';
      expect(validateFieldValue(null, pattern)).toBe(true);
    });

    it('accepts undefined (no validation needed)', () => {
      const pattern = '^\\d{8,}:[A-Za-z0-9_-]{30,50}$';
      expect(validateFieldValue(undefined, pattern)).toBe(true);
    });

    it('accepts any value when no pattern is provided', () => {
      expect(validateFieldValue('anything', undefined)).toBe(true);
    });

    it('throws error for invalid regex patterns', () => {
      const invalidPattern = '[unclosed';
      expect(() => validateFieldValue('test', invalidPattern)).toThrow(
        /Invalid validation pattern in catalog/
      );
    });
  });

  describe('allFieldsRequired contract', () => {
    it('slack entry has allFieldsRequired set', () => {
      const slack = SECRET_CATALOG_MAP.get('slack');
      expect(slack?.allFieldsRequired).toBe(true);
    });

    it('slack entry has exactly 2 fields', () => {
      const slack = SECRET_CATALOG_MAP.get('slack');
      expect(slack?.fields.length).toBe(2);
      expect(slack?.fields.map(f => f.key)).toEqual(['slackBotToken', 'slackAppToken']);
    });

    it('github entry has allFieldsRequired set', () => {
      const github = SECRET_CATALOG_MAP.get('github');
      expect(github?.allFieldsRequired).toBe(true);
    });

    it('github entry has exactly 3 fields', () => {
      const github = SECRET_CATALOG_MAP.get('github');
      expect(github?.fields.length).toBe(3);
      expect(github?.fields.map(f => f.key)).toEqual([
        'githubUsername',
        'githubEmail',
        'githubToken',
      ]);
    });

    it('telegram and discord do not have allFieldsRequired', () => {
      expect(SECRET_CATALOG_MAP.get('telegram')?.allFieldsRequired).toBeFalsy();
      expect(SECRET_CATALOG_MAP.get('discord')?.allFieldsRequired).toBeFalsy();
    });

    it('ALL_SECRET_FIELD_KEYS rejects unknown keys', () => {
      expect(ALL_SECRET_FIELD_KEYS.has('telegramBotToken')).toBe(true);
      expect(ALL_SECRET_FIELD_KEYS.has('unknownKey')).toBe(false);
      expect(ALL_SECRET_FIELD_KEYS.has('')).toBe(false);
    });

    it('FIELD_KEY_TO_ENTRY maps both slack fields to the same entry', () => {
      const botEntry = FIELD_KEY_TO_ENTRY.get('slackBotToken');
      const appEntry = FIELD_KEY_TO_ENTRY.get('slackAppToken');
      expect(botEntry).toBeDefined();
      expect(botEntry).toBe(appEntry);
      expect(botEntry?.allFieldsRequired).toBe(true);
    });
  });

  describe('INTERNAL_SENSITIVE_ENV_VARS', () => {
    it('contains Google credential env vars', () => {
      expect(INTERNAL_SENSITIVE_ENV_VARS.has('KILOCLAW_GOG_CONFIG_TARBALL')).toBe(true);
    });

    it('does not overlap with catalog-derived ALL_SECRET_ENV_VARS', () => {
      for (const envVar of INTERNAL_SENSITIVE_ENV_VARS) {
        expect(ALL_SECRET_ENV_VARS.has(envVar)).toBe(false);
      }
    });
  });

  describe('maxLength contract', () => {
    it('all maxLength values are within the global ceiling', () => {
      for (const entry of SECRET_CATALOG) {
        for (const field of entry.fields) {
          // JWT-based secrets (e.g. AgentCard) need up to 2000 chars
          expect(field.maxLength).toBeLessThanOrEqual(2000);
        }
      }
    });

    it('field-specific maxLength values are set correctly', () => {
      const telegram = FIELD_KEY_TO_ENTRY.get('telegramBotToken');
      const discord = FIELD_KEY_TO_ENTRY.get('discordBotToken');
      const slackBot = FIELD_KEY_TO_ENTRY.get('slackBotToken');

      expect(telegram?.fields[0].maxLength).toBe(100);
      expect(discord?.fields[0].maxLength).toBe(200);
      expect(slackBot?.fields.find(f => f.key === 'slackBotToken')?.maxLength).toBe(300);
      expect(slackBot?.fields.find(f => f.key === 'slackAppToken')?.maxLength).toBe(300);
    });
  });

  describe('isValidCustomSecretKey', () => {
    it('accepts valid custom env var names', () => {
      expect(isValidCustomSecretKey('MY_API_KEY')).toBe(true);
      expect(isValidCustomSecretKey('OPENAI_API_KEY')).toBe(true);
      expect(isValidCustomSecretKey('_PRIVATE')).toBe(true);
      expect(isValidCustomSecretKey('key123')).toBe(true);
      expect(isValidCustomSecretKey('A')).toBe(true);
    });

    it('rejects catalog field keys', () => {
      expect(isValidCustomSecretKey('telegramBotToken')).toBe(false);
      expect(isValidCustomSecretKey('discordBotToken')).toBe(false);
      expect(isValidCustomSecretKey('githubToken')).toBe(false);
    });

    it('rejects catalog env var names', () => {
      expect(isValidCustomSecretKey('TELEGRAM_BOT_TOKEN')).toBe(false);
      expect(isValidCustomSecretKey('DISCORD_BOT_TOKEN')).toBe(false);
      expect(isValidCustomSecretKey('GITHUB_TOKEN')).toBe(false);
      expect(isValidCustomSecretKey('BRAVE_API_KEY')).toBe(false);
      expect(isValidCustomSecretKey('KILO_EXA_SEARCH_MODE')).toBe(false);
    });

    it('rejects reserved prefixes', () => {
      expect(isValidCustomSecretKey('KILOCLAW_SECRET')).toBe(false);
      expect(isValidCustomSecretKey('KILOCLAW_ENC_FOO')).toBe(false);
      expect(isValidCustomSecretKey('OPENCLAW_SOMETHING')).toBe(false);
      expect(isValidCustomSecretKey('KILOCODE_API_KEY')).toBe(false);
      expect(isValidCustomSecretKey('FLY_REGION')).toBe(false);
      expect(isValidCustomSecretKey('NEXTAUTH_SECRET')).toBe(false);
      expect(isValidCustomSecretKey('NODE_OPTIONS')).toBe(false);
      expect(isValidCustomSecretKey('STREAM_CHAT_API_KEY')).toBe(false);
    });

    it('rejects denied exact env var names', () => {
      expect(isValidCustomSecretKey('PATH')).toBe(false);
      expect(isValidCustomSecretKey('HOME')).toBe(false);
      expect(isValidCustomSecretKey('AUTO_APPROVE_DEVICES')).toBe(false);
      expect(isValidCustomSecretKey('REQUIRE_PROXY_TOKEN')).toBe(false);
      expect(isValidCustomSecretKey('TELEGRAM_DM_POLICY')).toBe(false);
      expect(isValidCustomSecretKey('DISCORD_DM_POLICY')).toBe(false);
    });

    it('rejects invalid shell identifiers', () => {
      expect(isValidCustomSecretKey('123_START_WITH_NUM')).toBe(false);
      expect(isValidCustomSecretKey('has spaces')).toBe(false);
      expect(isValidCustomSecretKey('has-dashes')).toBe(false);
      expect(isValidCustomSecretKey('has.dots')).toBe(false);
      expect(isValidCustomSecretKey('')).toBe(false);
    });

    it('rejects keys exceeding 128 characters', () => {
      expect(isValidCustomSecretKey('A'.repeat(128))).toBe(true);
      expect(isValidCustomSecretKey('A'.repeat(129))).toBe(false);
    });
  });

  describe('isCustomSecretEnvVar', () => {
    it('returns true for non-catalog, non-internal env var names', () => {
      expect(isCustomSecretEnvVar('MY_CUSTOM_KEY')).toBe(true);
      expect(isCustomSecretEnvVar('OPENAI_API_KEY')).toBe(true);
    });

    it('returns false for catalog env var names', () => {
      expect(isCustomSecretEnvVar('TELEGRAM_BOT_TOKEN')).toBe(false);
      expect(isCustomSecretEnvVar('GITHUB_TOKEN')).toBe(false);
    });

    it('returns false for internal sensitive env vars', () => {
      expect(isCustomSecretEnvVar('KILOCLAW_GOG_CONFIG_TARBALL')).toBe(false);
    });
  });

  describe('custom secret constants', () => {
    it('MAX_CUSTOM_SECRETS is a reasonable limit', () => {
      expect(MAX_CUSTOM_SECRETS).toBe(50);
    });

    it('MAX_CUSTOM_SECRET_VALUE_LENGTH covers JWTs and certificates', () => {
      expect(MAX_CUSTOM_SECRET_VALUE_LENGTH).toBe(8192);
    });
  });

  describe('isValidConfigPath', () => {
    it('accepts supported OpenClaw credential paths', () => {
      expect(isValidConfigPath('models.providers.openai.apiKey')).toBe(true);
      expect(isValidConfigPath('tools.web.search.apiKey')).toBe(true);
      expect(isValidConfigPath('skills.entries.mySkill.apiKey')).toBe(true);
      expect(isValidConfigPath('cron.webhookToken')).toBe(true);
      expect(isValidConfigPath('talk.apiKey')).toBe(true);
      expect(isValidConfigPath('talk.providers.custom.apiKey')).toBe(true);
      expect(isValidConfigPath('messages.tts.providers.elevenlabs.apiKey')).toBe(true);
      expect(isValidConfigPath('plugins.entries.brave.config.webSearch.apiKey')).toBe(true);
      expect(isValidConfigPath('channels.irc.password')).toBe(true);
      expect(isValidConfigPath('channels.mattermost.botToken')).toBe(true);
      expect(isValidConfigPath('channels.matrix.password')).toBe(true);
      expect(isValidConfigPath('channels.msteams.appPassword')).toBe(true);
      expect(isValidConfigPath('channels.zalo.botToken')).toBe(true);
    });

    it('accepts wildcard pattern matches with concrete segments', () => {
      // models.providers.*.apiKey
      expect(isValidConfigPath('models.providers.anthropic.apiKey')).toBe(true);
      expect(isValidConfigPath('models.providers.my_custom.apiKey')).toBe(true);
      // models.providers.*.headers.*
      expect(isValidConfigPath('models.providers.openai.headers.Authorization')).toBe(true);
      // channels.*.accounts.*.token etc.
      expect(isValidConfigPath('channels.discord.accounts.bot2.token')).toBe(true);
      expect(isValidConfigPath('channels.slack.accounts.workspace1.botToken')).toBe(true);
    });

    it('accepts hyphenated segments for headers and channel names', () => {
      expect(isValidConfigPath('models.providers.openai.headers.x-api-key')).toBe(true);
      expect(isValidConfigPath('models.providers.openai.headers.anthropic-beta')).toBe(true);
      expect(isValidConfigPath('channels.nextcloud-talk.botSecret')).toBe(true);
      expect(isValidConfigPath('channels.nextcloud-talk.accounts.srv1.apiPassword')).toBe(true);
    });

    it('rejects empty strings', () => {
      expect(isValidConfigPath('')).toBe(false);
    });

    it('rejects paths with invalid characters', () => {
      expect(isValidConfigPath('has spaces.foo')).toBe(false);
      expect(isValidConfigPath('has-dashes.foo')).toBe(false);
      expect(isValidConfigPath('foo..bar')).toBe(false);
      expect(isValidConfigPath('.foo')).toBe(false);
      expect(isValidConfigPath('foo.')).toBe(false);
      expect(isValidConfigPath('123.foo')).toBe(false);
    });

    it('rejects paths not in the OpenClaw supported list', () => {
      expect(isValidConfigPath('foo.bar')).toBe(false);
      expect(isValidConfigPath('random.path.here')).toBe(false);
      expect(isValidConfigPath('tools.exec.security')).toBe(false);
      expect(isValidConfigPath('update.checkOnStart')).toBe(false);
      expect(isValidConfigPath('browser.headless')).toBe(false);
      expect(isValidConfigPath('tools.profile')).toBe(false);
    });

    it('rejects KiloClaw-managed paths', () => {
      expect(isValidConfigPath('gateway.auth.token')).toBe(false);
      expect(isValidConfigPath('gateway.auth.password')).toBe(false);
      expect(isValidConfigPath('gateway.remote.token')).toBe(false);
      expect(isValidConfigPath('gateway.remote.password')).toBe(false);
    });

    it('rejects catalog-managed secret paths', () => {
      expect(isValidConfigPath('channels.telegram.botToken')).toBe(false);
      expect(isValidConfigPath('channels.discord.token')).toBe(false);
      expect(isValidConfigPath('channels.slack.botToken')).toBe(false);
      expect(isValidConfigPath('channels.slack.appToken')).toBe(false);
    });

    it('rejects OpenClaw excluded credentials', () => {
      expect(isValidConfigPath('commands.ownerDisplaySecret')).toBe(false);
      expect(isValidConfigPath('channels.matrix.accessToken')).toBe(false);
      expect(isValidConfigPath('hooks.token')).toBe(false);
      expect(isValidConfigPath('hooks.gmail.pushToken')).toBe(false);
    });

    it('allows non-catalog channel account paths', () => {
      expect(isValidConfigPath('channels.telegram.accounts.bot2.botToken')).toBe(true);
      expect(isValidConfigPath('channels.irc.accounts.freenode.password')).toBe(true);
    });

    it('rejects paths exceeding max length', () => {
      const tooLong = 'models.providers.' + 'a'.repeat(240) + '.apiKey';
      expect(isValidConfigPath(tooLong)).toBe(false);
    });
  });
});
