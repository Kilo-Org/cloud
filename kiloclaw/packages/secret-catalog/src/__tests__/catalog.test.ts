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
      expect(tools.length).toBe(4);
      expect(tools[0].id).toBe('github');
      expect(tools[1].id).toBe('agentcard');
      expect(tools[2].id).toBe('onepassword');
      expect(tools[3].id).toBe('brave-search');
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
      expect(keys).toContain('agentcardApiKey');
      expect(keys).toContain('onepasswordServiceAccountToken');
      expect(keys).toContain('braveSearchApiKey');
      expect(keys.size).toBe(6);
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
});
