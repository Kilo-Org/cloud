import { describe, it, expect, vi } from 'vitest';
import {
  backupConfigFile,
  generateBaseConfig,
  setNestedValue,
  writeBaseConfig,
  writeMcporterConfig,
  MAX_CONFIG_BACKUPS,
} from './config-writer';

/** Minimal config that `openclaw onboard` would produce. */
const ONBOARD_CONFIG = JSON.stringify({
  gateway: { port: 3001, mode: 'local' },
  agents: { defaults: { model: { primary: 'kilocode/anthropic/claude-opus-4.6' } } },
  plugins: { entries: { telegram: { enabled: false }, discord: { enabled: false } } },
});

function fakeDeps(existingConfig?: string) {
  const written: { path: string; data: string }[] = [];
  const copied: { src: string; dest: string }[] = [];
  const renamed: { from: string; to: string }[] = [];
  const chmodded: { path: string; mode: number }[] = [];
  const unlinked: string[] = [];
  const execCalls: { cmd: string; args: string[]; env?: Record<string, string | undefined> }[] = [];
  let dirEntries: string[] = [];

  return {
    deps: {
      readFileSync: vi.fn((filePath: string) => {
        if (filePath.endsWith('openclaw.json') && existingConfig !== undefined)
          return existingConfig;
        // After execFileSync (onboard), the temp file "exists" with fresh config
        if (filePath.includes('.kilotmp.')) return ONBOARD_CONFIG;
        throw new Error(`ENOENT: no such file: ${filePath}`);
      }),
      writeFileSync: vi.fn((filePath: string, data: string) => {
        written.push({ path: filePath, data });
      }),
      renameSync: vi.fn((from: string, to: string) => {
        renamed.push({ from, to });
      }),
      chmodSync: vi.fn((filePath: string, mode: number) => {
        chmodded.push({ path: filePath, mode });
      }),
      copyFileSync: vi.fn((src: string, dest: string) => {
        copied.push({ src, dest });
        dirEntries = [...dirEntries, dest.split('/').pop() ?? dest];
      }),
      readdirSync: vi.fn(() => dirEntries),
      unlinkSync: vi.fn((filePath: string) => {
        unlinked.push(filePath);
      }),
      existsSync: vi.fn((filePath: string) => {
        if (filePath.endsWith('openclaw.json')) return existingConfig !== undefined;
        return false;
      }),
      execFileSync: vi.fn(
        (cmd: string, args: string[], opts: { env?: Record<string, string | undefined> }) => {
          execCalls.push({ cmd, args, env: opts.env });
        }
      ),
    },
    written,
    copied,
    renamed,
    chmodded,
    unlinked,
    execCalls,
    setDirEntries(entries: string[]) {
      dirEntries = entries;
    },
  };
}

function minimalEnv(): Record<string, string | undefined> {
  return {
    KILOCODE_API_KEY: 'test-api-key',
    OPENCLAW_GATEWAY_TOKEN: 'test-gw-token',
    AUTO_APPROVE_DEVICES: 'true',
  };
}

describe('generateBaseConfig', () => {
  it('generates config with gateway and exec defaults, no kilocode provider entry', () => {
    const { deps } = fakeDeps();
    const config = generateBaseConfig(minimalEnv(), '/tmp/openclaw.json', deps);

    // Gateway
    expect(config.gateway.port).toBe(3001);
    expect(config.gateway.mode).toBe('local');
    expect(config.gateway.bind).toBe('loopback');
    expect(config.gateway.auth.token).toBe('test-gw-token');
    expect(config.gateway.controlUi.allowInsecureAuth).toBe(true);

    // No kilocode provider entry in production — built-in provider takes over
    expect(config.models).toBeUndefined();

    // No default model override when env var not set, and no memorySearch
    // schema introduced when the feature is off and absent from existing config.
    expect(config.agents).toBeUndefined();

    // Tool profile
    expect(config.tools.profile).toBe('full');

    // Exec
    expect(config.tools.exec.host).toBe('gateway');
    expect(config.tools.exec.security).toBe('allowlist');
    expect(config.tools.exec.ask).toBe('on-miss');

    // Update checks disabled — KiloClaw manages updates via Docker images
    expect(config.update.checkOnStart).toBe(false);

    // Browser
    expect(config.browser.enabled).toBe(true);
    expect(config.browser.headless).toBe(true);
    expect(config.browser.noSandbox).toBe(true);
  });

  it('disables update.checkOnStart even when existing config has it enabled', () => {
    const existing = JSON.stringify({ update: { checkOnStart: true, channel: 'stable' } });
    const { deps } = fakeDeps(existing);
    const config = generateBaseConfig(minimalEnv(), '/tmp/openclaw.json', deps);

    expect(config.update.checkOnStart).toBe(false);
    // Preserves other update keys
    expect(config.update.channel).toBe('stable');
  });

  it('preserves user tool profile on non-fresh boot', () => {
    const existing = JSON.stringify({ tools: { profile: 'coding' } });
    const { deps } = fakeDeps(existing);
    const config = generateBaseConfig(minimalEnv(), '/tmp/openclaw.json', deps);

    expect(config.tools.profile).toBe('coding');
  });

  it('overrides tool profile to full on fresh install', () => {
    const existing = JSON.stringify({ tools: { profile: 'coding' } });
    const { deps } = fakeDeps(existing);
    const env = { ...minimalEnv(), KILOCLAW_FRESH_INSTALL: 'true' };
    const config = generateBaseConfig(env, '/tmp/openclaw.json', deps);

    expect(config.tools.profile).toBe('full');
  });

  it('preserves existing web search provider on non-fresh boot', () => {
    const existing = JSON.stringify({
      tools: {
        web: {
          search: {
            provider: 'brave',
          },
        },
      },
    });
    const { deps } = fakeDeps(existing);
    const config = generateBaseConfig(minimalEnv(), '/tmp/openclaw.json', deps);

    expect(config.tools.web.search.provider).toBe('brave');
  });

  it('auto-assigns kilo-exa when provider is missing and mode is unset', () => {
    const existing = JSON.stringify({ tools: { web: { search: {} } } });
    const { deps } = fakeDeps(existing);
    const config = generateBaseConfig(minimalEnv(), '/tmp/openclaw.json', deps);

    expect(config.tools.web.search.provider).toBe('kilo-exa');
    expect(config.tools.web.search.enabled).toBe(true);
    expect(config.plugins.entries['kiloclaw-customizer'].config.webSearch.enabled).toBe(true);
  });

  it('does not auto-assign kilo-exa when web search is explicitly disabled and provider is missing', () => {
    const existing = JSON.stringify({
      tools: {
        web: {
          search: {
            enabled: false,
          },
        },
      },
    });
    const { deps } = fakeDeps(existing);
    const config = generateBaseConfig(minimalEnv(), '/tmp/openclaw.json', deps);

    expect(config.tools.web.search.provider).toBeUndefined();
    expect(config.tools.web.search.enabled).toBe(false);
    expect(config.plugins.entries['kiloclaw-customizer'].config.webSearch.enabled).toBeUndefined();
  });

  it('does not auto-assign kilo-exa when BRAVE_API_KEY is configured and provider is missing', () => {
    const existing = JSON.stringify({ tools: { web: { search: {} } } });
    const { deps } = fakeDeps(existing);
    const env = {
      ...minimalEnv(),
      BRAVE_API_KEY: 'BSA' + 'A'.repeat(20),
    };
    const config = generateBaseConfig(env, '/tmp/openclaw.json', deps);

    expect(config.tools.web.search.provider).toBeUndefined();
    expect(config.plugins.entries['kiloclaw-customizer'].config.webSearch.enabled).toBeUndefined();
  });

  it('preserves explicit kilo-exa provider when mode is unset', () => {
    const existing = JSON.stringify({
      tools: {
        web: {
          search: {
            provider: 'kilo-exa',
          },
        },
      },
    });
    const { deps } = fakeDeps(existing);
    const config = generateBaseConfig(minimalEnv(), '/tmp/openclaw.json', deps);

    expect(config.tools.web.search.provider).toBe('kilo-exa');
    expect(config.plugins.entries['kiloclaw-customizer'].config.webSearch.enabled).toBe(true);
  });

  it('selects kilo-exa provider when KILO_EXA_SEARCH_MODE=kilo-proxy', () => {
    const { deps } = fakeDeps();
    const env = { ...minimalEnv(), KILO_EXA_SEARCH_MODE: 'kilo-proxy' };
    const config = generateBaseConfig(env, '/tmp/openclaw.json', deps);

    expect(config.tools.web.search.provider).toBe('kilo-exa');
    expect(config.tools.web.search.enabled).toBe(true);
    expect(config.plugins.entries['kiloclaw-customizer'].config.webSearch.enabled).toBe(true);
  });

  it('switches to brave when Exa is disabled and BRAVE_API_KEY is configured', () => {
    const existing = JSON.stringify({
      tools: {
        web: {
          search: {
            provider: 'kilo-exa',
          },
        },
      },
    });
    const { deps } = fakeDeps(existing);
    const env = {
      ...minimalEnv(),
      KILO_EXA_SEARCH_MODE: 'disabled',
      BRAVE_API_KEY: 'BSA' + 'A'.repeat(20),
    };
    const config = generateBaseConfig(env, '/tmp/openclaw.json', deps);

    expect(config.tools.web.search.provider).toBe('brave');
    expect(config.tools.web.search.enabled).toBe(true);
    expect(config.plugins.entries['kiloclaw-customizer'].config.webSearch.enabled).toBe(false);
  });

  it('preserves explicit non-Exa provider when Exa is disabled and BRAVE_API_KEY is configured', () => {
    const existing = JSON.stringify({
      tools: {
        web: {
          search: {
            provider: 'perplexity',
          },
        },
      },
    });
    const { deps } = fakeDeps(existing);
    const env = {
      ...minimalEnv(),
      KILO_EXA_SEARCH_MODE: 'disabled',
      BRAVE_API_KEY: 'BSA' + 'A'.repeat(20),
    };
    const config = generateBaseConfig(env, '/tmp/openclaw.json', deps);

    expect(config.tools.web.search.provider).toBe('perplexity');
    expect(config.plugins.entries['kiloclaw-customizer'].config.webSearch.enabled).toBe(false);
  });

  it('clears kilo-exa provider when Exa is disabled and Brave is not configured', () => {
    const existing = JSON.stringify({
      tools: {
        web: {
          search: {
            provider: 'kilo-exa',
          },
        },
      },
    });
    const { deps } = fakeDeps(existing);
    const env = {
      ...minimalEnv(),
      KILO_EXA_SEARCH_MODE: 'disabled',
    };
    const config = generateBaseConfig(env, '/tmp/openclaw.json', deps);

    expect(config.tools.web.search.provider).toBeUndefined();
    expect(config.plugins.entries['kiloclaw-customizer'].config.webSearch.enabled).toBe(false);
  });

  it('defaults tool profile to full when not previously set', () => {
    const { deps } = fakeDeps();
    const config = generateBaseConfig(minimalEnv(), '/tmp/openclaw.json', deps);

    expect(config.tools.profile).toBe('full');
  });

  it('preserves existing config keys not touched by the patch', () => {
    const existing = JSON.stringify({ custom: { key: 'value' }, gateway: { extra: true } });
    const { deps } = fakeDeps(existing);
    const config = generateBaseConfig(minimalEnv(), '/tmp/openclaw.json', deps);

    expect(config.custom.key).toBe('value');
    expect(config.gateway.extra).toBe(true);
    expect(config.gateway.port).toBe(3001);
  });

  it('removes stale kilocode provider with /api/openrouter/ baseUrl', () => {
    const existing = JSON.stringify({
      models: {
        providers: {
          kilocode: {
            baseUrl: 'https://api.kilo.ai/api/openrouter/',
            apiKey: 'old-key',
            api: 'openai-completions',
            models: [{ id: 'old/model', name: 'Old' }],
          },
        },
      },
    });
    const { deps } = fakeDeps(existing);
    const config = generateBaseConfig(minimalEnv(), '/tmp/openclaw.json', deps);

    // Stale provider deleted, models object cleaned up
    expect(config.models).toBeUndefined();
  });

  it('removes stale kilocode provider with production /api/gateway/ baseUrl', () => {
    const existing = JSON.stringify({
      models: {
        providers: {
          kilocode: {
            baseUrl: 'https://api.kilo.ai/api/gateway/',
            models: [],
          },
        },
      },
    });
    const { deps } = fakeDeps(existing);
    const config = generateBaseConfig(minimalEnv(), '/tmp/openclaw.json', deps);

    expect(config.models).toBeUndefined();
  });

  it('keeps gateway provider for org-scoped instances but clears static models', () => {
    const existing = JSON.stringify({
      models: {
        providers: {
          kilocode: {
            baseUrl: 'https://api.kilo.ai/api/gateway/',
            headers: { 'X-Custom': 'user-managed' },
            models: [{ id: 'kilo/auto', name: 'Kilo Auto' }],
          },
        },
      },
    });
    const { deps } = fakeDeps(existing);
    const env = { ...minimalEnv(), KILOCODE_ORGANIZATION_ID: 'org_abc123' };
    const config = generateBaseConfig(env, '/tmp/openclaw.json', deps);

    expect(config.models.providers.kilocode.headers['X-Custom']).toBe('user-managed');
    expect(config.models.providers.kilocode.headers['X-KiloCode-OrganizationId']).toBe(
      'org_abc123'
    );
    expect(config.models.providers.kilocode.baseUrl).toBe('https://api.kilo.ai/api/gateway/');
    expect(config.models.providers.kilocode.models).toEqual([]);
  });

  it('still removes openrouter stale provider for org-scoped instances', () => {
    const existing = JSON.stringify({
      models: {
        providers: {
          kilocode: {
            baseUrl: 'https://api.kilo.ai/api/openrouter/',
            headers: { 'X-Custom': 'stale' },
            models: [],
          },
        },
      },
    });
    const { deps } = fakeDeps(existing);
    const env = { ...minimalEnv(), KILOCODE_ORGANIZATION_ID: 'org_abc123' };
    const config = generateBaseConfig(env, '/tmp/openclaw.json', deps);

    // openrouter provider nuked, then rebuilt by org-header block
    expect(config.models.providers.kilocode.headers['X-Custom']).toBeUndefined();
    expect(config.models.providers.kilocode.headers['X-KiloCode-OrganizationId']).toBe(
      'org_abc123'
    );
    expect(config.models.providers.kilocode.baseUrl).toBe('https://api.kilo.ai/api/gateway/');
  });

  it('preserves non-kilocode providers when removing stale kilocode entry', () => {
    const existing = JSON.stringify({
      models: {
        providers: {
          kilocode: {
            baseUrl: 'https://api.kilo.ai/api/openrouter/',
            models: [],
          },
          openai: {
            baseUrl: 'https://api.openai.com/v1',
            models: [{ id: 'gpt-4', name: 'GPT-4' }],
          },
        },
      },
    });
    const { deps } = fakeDeps(existing);
    const config = generateBaseConfig(minimalEnv(), '/tmp/openclaw.json', deps);

    // kilocode removed, openai preserved
    expect(config.models.providers.kilocode).toBeUndefined();
    expect(config.models.providers.openai.baseUrl).toBe('https://api.openai.com/v1');
  });

  it('creates kilocode provider with baseUrl and models: [] when KILOCODE_API_BASE_URL is set', () => {
    const { deps } = fakeDeps();
    const env = { ...minimalEnv(), KILOCODE_API_BASE_URL: 'https://tunnel.example.com/' };
    const config = generateBaseConfig(env, '/tmp/openclaw.json', deps);

    expect(config.models.providers.kilocode.baseUrl).toBe('https://tunnel.example.com/');
    expect(config.models.providers.kilocode.models).toEqual([]);
  });

  it('preserves existing models array when overriding baseUrl', () => {
    const existing = JSON.stringify({
      models: {
        providers: {
          kilocode: {
            baseUrl: 'https://old-tunnel.example.com/',
            models: [{ id: 'kept/model', name: 'Kept' }],
          },
        },
      },
    });
    const { deps } = fakeDeps(existing);
    const env = { ...minimalEnv(), KILOCODE_API_BASE_URL: 'https://new-tunnel.example.com/' };
    const config = generateBaseConfig(env, '/tmp/openclaw.json', deps);

    // baseUrl updated, existing models preserved
    expect(config.models.providers.kilocode.baseUrl).toBe('https://new-tunnel.example.com/');
    expect(config.models.providers.kilocode.models).toEqual([{ id: 'kept/model', name: 'Kept' }]);
  });

  it('sets X-KiloCode-OrganizationId header when KILOCODE_ORGANIZATION_ID is set', () => {
    const { deps } = fakeDeps();
    const env = { ...minimalEnv(), KILOCODE_ORGANIZATION_ID: 'org_abc123' };
    const config = generateBaseConfig(env, '/tmp/openclaw.json', deps);

    expect(config.models.providers.kilocode.headers['X-KiloCode-OrganizationId']).toBe(
      'org_abc123'
    );
    // Explicit provider entries require a baseUrl per OpenClaw's strict schema
    expect(config.models.providers.kilocode.baseUrl).toBe('https://api.kilo.ai/api/gateway/');
    expect(config.models.providers.kilocode.models).toEqual([]);
  });

  it('does not set org header when KILOCODE_ORGANIZATION_ID is not set', () => {
    const { deps } = fakeDeps();
    const config = generateBaseConfig(minimalEnv(), '/tmp/openclaw.json', deps);

    // No kilocode provider entry created when neither baseUrl nor orgId is set
    expect(config.models).toBeUndefined();
  });

  it('preserves existing kilocode baseUrl and headers when adding org header', () => {
    const existing = JSON.stringify({
      models: {
        providers: {
          kilocode: {
            baseUrl: 'https://tunnel.example.com/',
            headers: { 'X-Custom': 'value' },
            models: [{ id: 'kept/model', name: 'Kept' }],
          },
        },
      },
    });
    const { deps } = fakeDeps(existing);
    const env = { ...minimalEnv(), KILOCODE_ORGANIZATION_ID: 'org_xyz789' };
    const config = generateBaseConfig(env, '/tmp/openclaw.json', deps);

    expect(config.models.providers.kilocode.headers['X-KiloCode-OrganizationId']).toBe(
      'org_xyz789'
    );
    expect(config.models.providers.kilocode.headers['X-Custom']).toBe('value');
    expect(config.models.providers.kilocode.baseUrl).toBe('https://tunnel.example.com/');
    expect(config.models.providers.kilocode.models).toEqual([]);
  });

  it('removes stale org header when KILOCODE_ORGANIZATION_ID is no longer set', () => {
    const existing = JSON.stringify({
      models: {
        providers: {
          kilocode: {
            baseUrl: 'https://tunnel.example.com/',
            headers: {
              'X-KiloCode-OrganizationId': 'org_old_stale',
              'X-Custom': 'preserved',
            },
            models: [{ id: 'kept/model', name: 'Kept' }],
          },
        },
      },
    });
    const { deps } = fakeDeps(existing);
    // No KILOCODE_ORGANIZATION_ID in env
    const config = generateBaseConfig(minimalEnv(), '/tmp/openclaw.json', deps);

    // Stale org header removed
    expect(config.models.providers.kilocode.headers['X-KiloCode-OrganizationId']).toBeUndefined();
    // Other headers and config preserved
    expect(config.models.providers.kilocode.headers['X-Custom']).toBe('preserved');
    expect(config.models.providers.kilocode.baseUrl).toBe('https://tunnel.example.com/');
    expect(config.models.providers.kilocode.models).toEqual([{ id: 'kept/model', name: 'Kept' }]);
  });

  it('removes agents.defaults.models allowlist left by openclaw onboard', () => {
    const existing = JSON.stringify({
      agents: {
        defaults: {
          model: { primary: 'kilocode/anthropic/claude-opus-4.6' },
          models: {
            'kilocode/anthropic/claude-opus-4.6': { alias: 'Kilo Gateway' },
          },
        },
      },
    });
    const { deps } = fakeDeps(existing);
    const config = generateBaseConfig(minimalEnv(), '/tmp/openclaw.json', deps);

    expect(config.agents.defaults.models).toBeUndefined();
    // model.primary should still be preserved
    expect(config.agents.defaults.model.primary).toBe('kilocode/anthropic/claude-opus-4.6');
  });

  it('overrides default model only when KILOCODE_DEFAULT_MODEL is set', () => {
    const { deps } = fakeDeps();
    const env = { ...minimalEnv(), KILOCODE_DEFAULT_MODEL: 'kilocode/openai/gpt-5' };
    const config = generateBaseConfig(env, '/tmp/openclaw.json', deps);

    expect(config.agents.defaults.model.primary).toBe('kilocode/openai/gpt-5');
  });

  it('preserves agent model fallback settings on restart', () => {
    const existing = JSON.stringify({
      agents: {
        defaults: {
          model: {
            primary: 'kilocode/anthropic/claude-opus-4.6',
            fallback: 'kilocode/openai/gpt-5',
            customSetting: 'user-value',
          },
        },
      },
    });
    const { deps } = fakeDeps(existing);
    const env = { ...minimalEnv(), KILOCODE_DEFAULT_MODEL: 'kilocode/openai/gpt-5' };
    const config = generateBaseConfig(env, '/tmp/openclaw.json', deps);

    expect(config.agents.defaults.model.primary).toBe('kilocode/openai/gpt-5');
    expect(config.agents.defaults.model.fallback).toBe('kilocode/openai/gpt-5');
    expect(config.agents.defaults.model.customSetting).toBe('user-value');
  });

  it('does not set default model when KILOCODE_DEFAULT_MODEL is not set', () => {
    const { deps } = fakeDeps();
    const config = generateBaseConfig(minimalEnv(), '/tmp/openclaw.json', deps);

    expect(config.agents).toBeUndefined();
  });

  it('sets agent user timezone from KILOCLAW_USER_TIMEZONE', () => {
    const { deps } = fakeDeps();
    const env = { ...minimalEnv(), KILOCLAW_USER_TIMEZONE: 'Europe/Amsterdam' };
    const config = generateBaseConfig(env, '/tmp/openclaw.json', deps);

    expect(config.agents.defaults.userTimezone).toBe('Europe/Amsterdam');
  });

  it('preserves existing agent user timezone when KILOCLAW_USER_TIMEZONE is not set', () => {
    const existing = JSON.stringify({
      agents: { defaults: { userTimezone: 'Asia/Tokyo' } },
    });
    const { deps } = fakeDeps(existing);
    const config = generateBaseConfig(minimalEnv(), '/tmp/openclaw.json', deps);

    expect(config.agents.defaults.userTimezone).toBe('Asia/Tokyo');
  });

  it('configures allowed origins from env', () => {
    const { deps } = fakeDeps();
    const env = {
      ...minimalEnv(),
      OPENCLAW_ALLOWED_ORIGINS: 'http://localhost:3000, https://claw.kilo.ai',
    };
    const config = generateBaseConfig(env, '/tmp/openclaw.json', deps);

    expect(config.gateway.controlUi.allowedOrigins).toEqual([
      'http://localhost:3000',
      'https://claw.kilo.ai',
    ]);
  });

  it('always configures the KiloClaw customizer plugin', () => {
    const { deps } = fakeDeps();
    const config = generateBaseConfig(minimalEnv(), '/tmp/openclaw.json', deps);

    expect(config.plugins.entries['kiloclaw-customizer'].enabled).toBe(true);
    expect(config.plugins.load.paths).toContain(
      '/usr/local/lib/node_modules/@kiloclaw/kiloclaw-customizer'
    );
    expect(config.plugins.entries['kiloclaw-morning-briefing'].enabled).toBe(true);
    expect(config.plugins.load.paths).toContain(
      '/usr/local/lib/node_modules/@kiloclaw/kiloclaw-morning-briefing'
    );
  });

  it('does not duplicate KiloClaw customizer plugin path on repeated generateBaseConfig calls', () => {
    const existing = JSON.stringify({
      plugins: {
        load: {
          paths: [
            '/usr/local/lib/node_modules/@kiloclaw/kiloclaw-customizer',
            '/usr/local/lib/node_modules/@kiloclaw/kiloclaw-morning-briefing',
          ],
        },
        entries: {
          'kiloclaw-customizer': { enabled: true },
          'kiloclaw-morning-briefing': { enabled: true },
        },
      },
    });
    const { deps } = fakeDeps(existing);
    const config = generateBaseConfig(minimalEnv(), '/tmp/openclaw.json', deps);

    const pluginPath = '/usr/local/lib/node_modules/@kiloclaw/kiloclaw-customizer';
    const paths = config.plugins.load.paths as string[];
    expect(paths.filter(p => p === pluginPath)).toHaveLength(1);
    const morningPluginPath = '/usr/local/lib/node_modules/@kiloclaw/kiloclaw-morning-briefing';
    expect(paths.filter(p => p === morningPluginPath)).toHaveLength(1);
  });

  it('adds KiloClaw customizer to an existing plugin allowlist', () => {
    const existing = JSON.stringify({
      plugins: {
        allow: ['openclaw-channel-streamchat', 'telegram', 'kilocode', 'browser'],
      },
    });
    const { deps } = fakeDeps(existing);
    const config = generateBaseConfig(minimalEnv(), '/tmp/openclaw.json', deps);

    expect(config.plugins.allow).toContain('kiloclaw-customizer');
    expect(config.plugins.allow).toContain('kiloclaw-morning-briefing');
  });

  it('configures Telegram channel', () => {
    const { deps } = fakeDeps();
    const env = { ...minimalEnv(), TELEGRAM_BOT_TOKEN: 'tg-token-123' };
    const config = generateBaseConfig(env, '/tmp/openclaw.json', deps);

    expect(config.channels.telegram.botToken).toBe('tg-token-123');
    expect(config.channels.telegram.enabled).toBe(true);
    expect(config.channels.telegram.dmPolicy).toBe('pairing');
    expect(config.plugins.entries.telegram.enabled).toBe(true);
  });

  it('preserves user Telegram customizations on restart', () => {
    const existing = JSON.stringify({
      channels: {
        telegram: {
          botToken: 'tg-token-old',
          enabled: true,
          dmPolicy: 'pairing',
          groupPolicy: 'restricted',
          customField: 'user-value',
        },
      },
    });
    const { deps } = fakeDeps(existing);
    const env = { ...minimalEnv(), TELEGRAM_BOT_TOKEN: 'tg-token-new' };
    const config = generateBaseConfig(env, '/tmp/openclaw.json', deps);

    expect(config.channels.telegram.botToken).toBe('tg-token-new');
    expect(config.channels.telegram.enabled).toBe(true);
    expect(config.channels.telegram.groupPolicy).toBe('restricted');
    expect(config.channels.telegram.customField).toBe('user-value');
  });

  it('configures Telegram with open DM policy and allowFrom wildcard', () => {
    const { deps } = fakeDeps();
    const env = {
      ...minimalEnv(),
      TELEGRAM_BOT_TOKEN: 'tg-token',
      TELEGRAM_DM_POLICY: 'open',
    };
    const config = generateBaseConfig(env, '/tmp/openclaw.json', deps);

    expect(config.channels.telegram.dmPolicy).toBe('open');
    expect(config.channels.telegram.allowFrom).toEqual(['*']);
  });

  it('configures Discord channel', () => {
    const { deps } = fakeDeps();
    const env = { ...minimalEnv(), DISCORD_BOT_TOKEN: 'dc-token-456' };
    const config = generateBaseConfig(env, '/tmp/openclaw.json', deps);

    expect(config.channels.discord.token).toBe('dc-token-456');
    expect(config.channels.discord.enabled).toBe(true);
    expect(config.channels.discord.dm.policy).toBe('pairing');
    expect(config.plugins.entries.discord.enabled).toBe(true);
  });

  it('preserves user Discord customizations on restart', () => {
    const existing = JSON.stringify({
      channels: {
        discord: {
          token: 'dc-token-old',
          enabled: true,
          dm: { policy: 'pairing' },
          guilds: { '123456': { name: 'My Server' } },
        },
      },
    });
    const { deps } = fakeDeps(existing);
    const env = { ...minimalEnv(), DISCORD_BOT_TOKEN: 'dc-token-new' };
    const config = generateBaseConfig(env, '/tmp/openclaw.json', deps);

    expect(config.channels.discord.token).toBe('dc-token-new');
    expect(config.channels.discord.enabled).toBe(true);
    expect(config.channels.discord.guilds).toEqual({ '123456': { name: 'My Server' } });
  });

  it('configures Slack channel when both tokens present', () => {
    const { deps } = fakeDeps();
    const env = {
      ...minimalEnv(),
      SLACK_BOT_TOKEN: 'slack-bot',
      SLACK_APP_TOKEN: 'slack-app',
    };
    const config = generateBaseConfig(env, '/tmp/openclaw.json', deps);

    expect(config.channels.slack.botToken).toBe('slack-bot');
    expect(config.channels.slack.appToken).toBe('slack-app');
    expect(config.channels.slack.enabled).toBe(true);
    expect(config.plugins.entries.slack.enabled).toBe(true);
  });

  it('preserves user Slack customizations on restart', () => {
    const existing = JSON.stringify({
      channels: {
        slack: {
          botToken: 'slack-bot-old',
          appToken: 'slack-app-old',
          enabled: true,
          slashCommands: ['/deploy', '/status'],
          customField: 'preserved',
        },
      },
    });
    const { deps } = fakeDeps(existing);
    const env = {
      ...minimalEnv(),
      SLACK_BOT_TOKEN: 'slack-bot-new',
      SLACK_APP_TOKEN: 'slack-app-new',
    };
    const config = generateBaseConfig(env, '/tmp/openclaw.json', deps);

    expect(config.channels.slack.botToken).toBe('slack-bot-new');
    expect(config.channels.slack.appToken).toBe('slack-app-new');
    expect(config.channels.slack.enabled).toBe(true);
    expect(config.channels.slack.slashCommands).toEqual(['/deploy', '/status']);
    expect(config.channels.slack.customField).toBe('preserved');
  });

  it('does not configure Slack when only bot token present', () => {
    const { deps } = fakeDeps();
    const env = { ...minimalEnv(), SLACK_BOT_TOKEN: 'slack-bot' };
    const config = generateBaseConfig(env, '/tmp/openclaw.json', deps);

    expect(config.channels.slack).toBeUndefined();
  });

  // ─── Stream Chat (default channel) ───────────────────────────────────────

  it('configures Stream Chat channel and plugin when all three vars are set', () => {
    const { deps } = fakeDeps();
    const env = {
      ...minimalEnv(),
      STREAM_CHAT_API_KEY: 'sc-api-key',
      STREAM_CHAT_BOT_USER_ID: 'bot-sandbox-abc',
      STREAM_CHAT_BOT_USER_TOKEN: 'sc-bot-token',
    };
    const config = generateBaseConfig(env, '/tmp/openclaw.json', deps);

    expect(config.channels.streamchat.apiKey).toBe('sc-api-key');
    expect(config.channels.streamchat.botUserId).toBe('bot-sandbox-abc');
    expect(config.channels.streamchat.botUserToken).toBe('sc-bot-token');
    expect(config.channels.streamchat.botUserName).toBe('KiloClaw');
    expect(config.channels.streamchat.enabled).toBe(true);
    expect(config.plugins.entries['openclaw-channel-streamchat'].enabled).toBe(true);
    expect(config.plugins.load.paths).toContain(
      '/usr/local/lib/node_modules/@wunderchat/openclaw-channel-streamchat'
    );
  });

  it('does not configure Stream Chat when any of the three required vars is missing', () => {
    const cases = [
      { STREAM_CHAT_API_KEY: 'key', STREAM_CHAT_BOT_USER_ID: 'bot' },
      { STREAM_CHAT_API_KEY: 'key', STREAM_CHAT_BOT_USER_TOKEN: 'token' },
      { STREAM_CHAT_BOT_USER_ID: 'bot', STREAM_CHAT_BOT_USER_TOKEN: 'token' },
    ];

    for (const partial of cases) {
      const { deps } = fakeDeps();
      const env = { ...minimalEnv(), ...partial };
      const config = generateBaseConfig(env, '/tmp/openclaw.json', deps);
      expect(config.channels.streamchat).toBeUndefined();
    }
  });

  it('does not duplicate the plugin path on repeated generateBaseConfig calls', () => {
    const existing = JSON.stringify({
      channels: { streamchat: { apiKey: 'old-key', enabled: true } },
      plugins: {
        load: {
          paths: ['/usr/local/lib/node_modules/@wunderchat/openclaw-channel-streamchat'],
        },
        entries: { 'openclaw-channel-streamchat': { enabled: true } },
      },
    });
    const { deps } = fakeDeps(existing);
    const env = {
      ...minimalEnv(),
      STREAM_CHAT_API_KEY: 'sc-api-key',
      STREAM_CHAT_BOT_USER_ID: 'bot-sandbox-abc',
      STREAM_CHAT_BOT_USER_TOKEN: 'sc-bot-token',
    };
    const config = generateBaseConfig(env, '/tmp/openclaw.json', deps);

    const pluginPath = '/usr/local/lib/node_modules/@wunderchat/openclaw-channel-streamchat';
    const paths = config.plugins.load.paths as string[];
    expect(paths.filter(p => p === pluginPath)).toHaveLength(1);
  });

  it('does not set gateway auth when OPENCLAW_GATEWAY_TOKEN is missing', () => {
    const { deps } = fakeDeps();
    const env = { ...minimalEnv() };
    delete env.OPENCLAW_GATEWAY_TOKEN;
    const config = generateBaseConfig(env, '/tmp/openclaw.json', deps);

    expect(config.gateway.auth).toBeUndefined();
  });

  it('does not set allowInsecureAuth when AUTO_APPROVE_DEVICES is not true', () => {
    const { deps } = fakeDeps();
    const env = { ...minimalEnv() };
    delete env.AUTO_APPROVE_DEVICES;
    const config = generateBaseConfig(env, '/tmp/openclaw.json', deps);

    expect(config.gateway.controlUi?.allowInsecureAuth).toBeUndefined();
  });

  it('does not set allowInsecureAuth when AUTO_APPROVE_DEVICES is false', () => {
    const { deps } = fakeDeps();
    const env = { ...minimalEnv(), AUTO_APPROVE_DEVICES: 'false' };
    const config = generateBaseConfig(env, '/tmp/openclaw.json', deps);

    expect(config.gateway.controlUi?.allowInsecureAuth).toBeUndefined();
  });

  it('configures Telegram allowFrom from explicit comma-separated list', () => {
    const { deps } = fakeDeps();
    const env = {
      ...minimalEnv(),
      TELEGRAM_BOT_TOKEN: 'tg-token',
      TELEGRAM_DM_ALLOW_FROM: 'user1,user2',
    };
    const config = generateBaseConfig(env, '/tmp/openclaw.json', deps);

    expect(config.channels.telegram.allowFrom).toEqual(['user1', 'user2']);
    expect(config.channels.telegram.dmPolicy).toBe('pairing');
  });

  it('configures inbound email hooks when KILOCLAW_HOOKS_TOKEN is set', () => {
    const { deps } = fakeDeps();
    const env = { ...minimalEnv(), KILOCLAW_HOOKS_TOKEN: 'test-hooks-token' };
    const config = generateBaseConfig(env, '/tmp/openclaw.json', deps);

    expect(config.hooks.enabled).toBe(true);
    expect(config.hooks.token).toBe('test-hooks-token');
    expect(config.hooks.path).toBe('/hooks');
    expect(config.hooks.presets).toBeUndefined();
    expect(config.hooks.mappings).toContainEqual({
      id: 'cloudflare-email-inbound',
      match: { path: 'email' },
      action: 'agent',
      wakeMode: 'now',
      name: 'Inbound Email',
      sessionKey: '{{payload.sessionKey}}',
      messageTemplate: 'From: {{payload.from}}\nSubject: {{payload.subject}}\n\n{{payload.text}}',
      deliver: false,
    });
  });

  it('migrates existing inbound email wake hook to agent mapping', () => {
    const existing = JSON.stringify({
      hooks: {
        mappings: [
          {
            id: 'cloudflare-email-inbound',
            match: { path: 'email' },
            action: 'wake',
            wakeMode: 'now',
            name: 'Inbound Email',
            sessionKey: '{{payload.sessionKey}}',
            textTemplate: 'old template',
            deliver: false,
          },
          {
            id: 'custom-wake',
            action: 'wake',
            messageTemplate: 'custom template',
          },
        ],
      },
    });
    const { deps } = fakeDeps(existing);
    const env = { ...minimalEnv(), KILOCLAW_HOOKS_TOKEN: 'test-hooks-token' };
    const config = generateBaseConfig(env, '/tmp/openclaw.json', deps);

    expect(config.hooks.mappings).toContainEqual({
      id: 'cloudflare-email-inbound',
      match: { path: 'email' },
      action: 'agent',
      wakeMode: 'now',
      name: 'Inbound Email',
      sessionKey: '{{payload.sessionKey}}',
      messageTemplate: 'From: {{payload.from}}\nSubject: {{payload.subject}}\n\n{{payload.text}}',
      deliver: false,
    });
    expect(config.hooks.mappings).toContainEqual({
      id: 'custom-wake',
      action: 'wake',
      textTemplate: 'custom template',
    });
    expect(config.hooks.mappings).not.toContainEqual(
      expect.objectContaining({ id: 'cloudflare-email-inbound', action: 'wake' })
    );
    expect(config.hooks.mappings).not.toContainEqual(
      expect.objectContaining({ id: 'cloudflare-email-inbound', textTemplate: expect.any(String) })
    );
    expect(config.hooks.mappings).toContainEqual(
      expect.objectContaining({ id: 'cloudflare-email-inbound', wakeMode: 'now' })
    );
  });

  it('adds gmail preset when Gog credentials are configured', () => {
    const { deps } = fakeDeps();
    const env = {
      ...minimalEnv(),
      KILOCLAW_HOOKS_TOKEN: 'test-hooks-token',
      KILOCLAW_GOG_CONFIG_TARBALL: 'tarball',
    };
    const config = generateBaseConfig(env, '/tmp/openclaw.json', deps);

    expect(config.hooks.presets).toContain('gmail');
  });

  it('does not configure hooks when KILOCLAW_HOOKS_TOKEN is not set', () => {
    const { deps } = fakeDeps();
    const config = generateBaseConfig(minimalEnv(), '/tmp/openclaw.json', deps);

    expect(config.hooks).toBeUndefined();
  });

  it('does not duplicate gmail preset in hooks', () => {
    const existing = JSON.stringify({
      hooks: { enabled: true, token: 'old-token', presets: ['gmail'] },
    });
    const { deps } = fakeDeps(existing);
    const env = {
      ...minimalEnv(),
      KILOCLAW_HOOKS_TOKEN: 'new-token',
      KILOCLAW_GOG_CONFIG_TARBALL: 'tarball',
    };
    const config = generateBaseConfig(env, '/tmp/openclaw.json', deps);

    expect(config.hooks.presets).toEqual(['gmail']);
    expect(config.hooks.token).toBe('new-token');
  });

  it('reads exec security and ask from env vars', () => {
    const { deps } = fakeDeps();
    const env = {
      ...minimalEnv(),
      KILOCLAW_EXEC_SECURITY: 'full',
      KILOCLAW_EXEC_ASK: 'off',
    };
    const config = generateBaseConfig(env, '/tmp/openclaw.json', deps);

    expect(config.tools.exec.host).toBe('gateway');
    expect(config.tools.exec.security).toBe('full');
    expect(config.tools.exec.ask).toBe('off');
  });

  it('falls back to defaults when exec env vars are not set', () => {
    const { deps } = fakeDeps();
    const config = generateBaseConfig(minimalEnv(), '/tmp/openclaw.json', deps);

    expect(config.tools.exec.security).toBe('allowlist');
    expect(config.tools.exec.ask).toBe('on-miss');
  });

  it('patches custom secrets into config via KILOCLAW_SECRET_CONFIG_PATHS', () => {
    const { deps } = fakeDeps();
    const config = generateBaseConfig(
      {
        MY_API_KEY: 'sk-test-123',
        ANOTHER_KEY: 'value-456',
        KILOCLAW_SECRET_CONFIG_PATHS: JSON.stringify({
          MY_API_KEY: 'models.providers.openai.apiKey',
          ANOTHER_KEY: 'channels.custom.token',
        }),
      },
      '/root/.openclaw/openclaw.json',
      deps
    );

    expect(config.models.providers.openai.apiKey).toBe('sk-test-123');
    expect(config.channels.custom.token).toBe('value-456');
  });

  it('skips config path patching for missing env vars', () => {
    const { deps } = fakeDeps();
    const config = generateBaseConfig(
      {
        KILOCLAW_SECRET_CONFIG_PATHS: JSON.stringify({
          MISSING_KEY: 'models.providers.openai.apiKey',
        }),
      },
      '/root/.openclaw/openclaw.json',
      deps
    );

    expect(config.models?.providers?.openai?.apiKey).toBeUndefined();
  });

  it('handles malformed KILOCLAW_SECRET_CONFIG_PATHS gracefully', () => {
    const { deps } = fakeDeps();
    // Should not throw, just warn
    const config = generateBaseConfig(
      { KILOCLAW_SECRET_CONFIG_PATHS: 'not-valid-json' },
      '/root/.openclaw/openclaw.json',
      deps
    );
    expect(config).toBeDefined();
  });

  // ── Vector memory ───────────────────────────────────────────────────

  it('does not introduce memorySearch schema when disabled and absent from existing config', () => {
    // Older OpenClaw versions (< 2026.4.5) reject agents.defaults.memorySearch
    // during `doctor` validation. When the feature is off and the config never
    // had it, leave the config untouched so those versions keep booting.
    const { deps } = fakeDeps();
    const config = generateBaseConfig(minimalEnv(), '/tmp/openclaw.json', deps);
    expect(config.agents?.defaults?.memorySearch).toBeUndefined();
  });

  it('enables memorySearch via Kilo Gateway when the flag is on', () => {
    const { deps } = fakeDeps();
    const env = {
      ...minimalEnv(),
      KILOCLAW_VECTOR_MEMORY_ENABLED: 'true',
      KILOCLAW_VECTOR_MEMORY_MODEL: 'openai/text-embedding-3-small',
    };
    const config = generateBaseConfig(env, '/tmp/openclaw.json', deps);
    expect(config.agents.defaults.memorySearch.enabled).toBe(true);
    expect(config.agents.defaults.memorySearch.provider).toBe('openai');
    expect(config.agents.defaults.memorySearch.model).toBe('openai/text-embedding-3-small');
    expect(config.agents.defaults.memorySearch.remote.baseUrl).toBe(
      'https://api.kilo.ai/api/gateway/'
    );
    expect(config.agents.defaults.memorySearch.remote.apiKey).toBe('test-api-key');
    expect(config.agents.defaults.memorySearch.remote.headers).toEqual({
      'x-kilocode-feature': 'kiloclaw-embedding',
    });
  });

  it('falls back to the default embedding model when no model env var is set', () => {
    const { deps } = fakeDeps();
    const env = { ...minimalEnv(), KILOCLAW_VECTOR_MEMORY_ENABLED: 'true' };
    const config = generateBaseConfig(env, '/tmp/openclaw.json', deps);
    expect(config.agents.defaults.memorySearch.model).toBe('mistralai/mistral-embed-2312');
  });

  it('honors KILOCODE_API_BASE_URL override on the memorySearch remote block', () => {
    const { deps } = fakeDeps();
    const env = {
      ...minimalEnv(),
      KILOCLAW_VECTOR_MEMORY_ENABLED: 'true',
      KILOCODE_API_BASE_URL: 'https://example.internal/gateway/',
    };
    const config = generateBaseConfig(env, '/tmp/openclaw.json', deps);
    expect(config.agents.defaults.memorySearch.remote.baseUrl).toBe(
      'https://example.internal/gateway/'
    );
  });

  it('adds X-KiloCode-OrganizationId memorySearch header when org id is set', () => {
    const { deps } = fakeDeps();
    const env = {
      ...minimalEnv(),
      KILOCLAW_VECTOR_MEMORY_ENABLED: 'true',
      KILOCODE_ORGANIZATION_ID: 'org_abc123',
    };
    const config = generateBaseConfig(env, '/tmp/openclaw.json', deps);
    expect(config.agents.defaults.memorySearch.remote.headers).toEqual({
      'x-kilocode-feature': 'kiloclaw-embedding',
      'X-KiloCode-OrganizationId': 'org_abc123',
    });
  });

  it('clears stale memorySearch.remote config when disabled on a subsequent boot', () => {
    const existing = JSON.stringify({
      agents: {
        defaults: {
          memorySearch: {
            enabled: true,
            provider: 'openai',
            model: 'openai/text-embedding-3-small',
            remote: { baseUrl: 'https://old/', apiKey: 'stale', headers: {} },
          },
        },
      },
    });
    const { deps } = fakeDeps(existing);
    const config = generateBaseConfig(minimalEnv(), '/tmp/openclaw.json', deps);
    expect(config.agents.defaults.memorySearch.enabled).toBe(false);
    expect(config.agents.defaults.memorySearch.provider).toBeUndefined();
    expect(config.agents.defaults.memorySearch.model).toBeUndefined();
    expect(config.agents.defaults.memorySearch.remote).toBeUndefined();
  });

  // ── Dreaming ────────────────────────────────────────────────────────

  it('does not introduce memory-core dreaming schema when disabled and absent from existing config', () => {
    // Older OpenClaw versions (< 2026.4.5) reject
    // plugins.entries['memory-core'].config.dreaming during `doctor` validation.
    // When the feature is off and the config never had it, leave it untouched.
    const { deps } = fakeDeps();
    const config = generateBaseConfig(minimalEnv(), '/tmp/openclaw.json', deps);
    expect(config.plugins.entries['memory-core']).toBeUndefined();
  });

  it('enables dreaming when KILOCLAW_DREAMING_ENABLED=true', () => {
    const { deps } = fakeDeps();
    const env = { ...minimalEnv(), KILOCLAW_DREAMING_ENABLED: 'true' };
    const config = generateBaseConfig(env, '/tmp/openclaw.json', deps);
    expect(config.plugins.entries['memory-core'].config.dreaming.enabled).toBe(true);
  });

  it('flips dreaming off without deleting other memory-core plugin config', () => {
    const existing = JSON.stringify({
      plugins: {
        entries: {
          'memory-core': { config: { dreaming: { enabled: true }, extra: 'keep-me' } },
        },
      },
    });
    const { deps } = fakeDeps(existing);
    const config = generateBaseConfig(minimalEnv(), '/tmp/openclaw.json', deps);
    expect(config.plugins.entries['memory-core'].config.dreaming.enabled).toBe(false);
    expect(config.plugins.entries['memory-core'].config.extra).toBe('keep-me');
  });

  it('leaves memory-core plugin config untouched when dreaming is off and entry lacks dreaming', () => {
    // If memory-core exists for another reason but has never had a dreaming key,
    // we must not introduce one — older OpenClaw versions reject it.
    const existing = JSON.stringify({
      plugins: {
        entries: {
          'memory-core': { config: { extra: 'keep-me' } },
        },
      },
    });
    const { deps } = fakeDeps(existing);
    const config = generateBaseConfig(minimalEnv(), '/tmp/openclaw.json', deps);
    expect(config.plugins.entries['memory-core'].config.dreaming).toBeUndefined();
    expect(config.plugins.entries['memory-core'].config.extra).toBe('keep-me');
  });
});

describe('setNestedValue', () => {
  it('sets a value at a simple path', () => {
    const obj: Record<string, unknown> = {};
    setNestedValue(obj, 'foo', 'bar');
    expect(obj.foo).toBe('bar');
  });

  it('sets a value at a nested path, creating intermediates', () => {
    const obj: Record<string, unknown> = {};
    setNestedValue(obj, 'a.b.c', 'value');
    expect((obj as any).a.b.c).toBe('value');
  });

  it('preserves existing sibling keys', () => {
    const obj: Record<string, unknown> = { a: { existing: true } };
    setNestedValue(obj, 'a.newKey', 'value');
    expect((obj as any).a.existing).toBe(true);
    expect((obj as any).a.newKey).toBe('value');
  });

  it('overwrites existing values', () => {
    const obj: Record<string, unknown> = { a: { b: 'old' } };
    setNestedValue(obj, 'a.b', 'new');
    expect((obj as any).a.b).toBe('new');
  });

  it('refuses to patch __proto__ segments', () => {
    const obj: Record<string, unknown> = {};
    setNestedValue(obj, '__proto__.polluted', 'yes');
    expect(({} as any).polluted).toBeUndefined();
  });

  it('refuses to patch constructor segments', () => {
    const obj: Record<string, unknown> = {};
    setNestedValue(obj, 'constructor.prototype.polluted', 'yes');
    expect(({} as any).polluted).toBeUndefined();
  });

  it('refuses to patch prototype segments', () => {
    const obj: Record<string, unknown> = {};
    setNestedValue(obj, 'a.prototype.b', 'yes');
    expect((obj as any).a).toBeUndefined();
  });

  it('skips when intermediate is a non-object primitive', () => {
    const obj: Record<string, unknown> = { a: 'string-not-object' };
    setNestedValue(obj, 'a.b.c', 'value');
    expect(obj.a).toBe('string-not-object');
  });
});

describe('backupConfigFile', () => {
  it('backs up existing config with timestamp', () => {
    const existing = JSON.stringify({ old: true });
    const { deps, copied } = fakeDeps(existing);

    backupConfigFile('/tmp/openclaw.json', deps);

    expect(copied).toHaveLength(1);
    expect(copied[0].src).toBe('/tmp/openclaw.json');
    expect(copied[0].dest).toMatch(/\/tmp\/openclaw\.json\.bak\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-/);
  });

  it('prunes old backups beyond MAX_CONFIG_BACKUPS', () => {
    const existing = JSON.stringify({ old: true });
    const harness = fakeDeps(existing);
    harness.setDirEntries([
      'openclaw.json.bak.2026-02-20T10-00-00.000Z',
      'openclaw.json.bak.2026-02-21T10-00-00.000Z',
      'openclaw.json.bak.2026-02-22T10-00-00.000Z',
      'openclaw.json.bak.2026-02-23T10-00-00.000Z',
      'openclaw.json.bak.2026-02-24T10-00-00.000Z',
      'openclaw.json.bak.2026-02-25T10-00-00.000Z',
      'openclaw.json.bak.2026-02-26T10-00-00.000Z',
    ]);

    backupConfigFile('/tmp/openclaw.json', harness.deps);

    expect(harness.unlinked).toHaveLength(8 - MAX_CONFIG_BACKUPS);
    expect(harness.unlinked[0]).toBe('/tmp/openclaw.json.bak.2026-02-20T10-00-00.000Z');
    expect(harness.unlinked[1]).toBe('/tmp/openclaw.json.bak.2026-02-21T10-00-00.000Z');
  });

  it('continues if backup pruning fails', () => {
    const existing = JSON.stringify({ old: true });
    const harness = fakeDeps(existing);
    harness.deps.readdirSync.mockImplementation(() => {
      throw new Error('permission denied');
    });

    expect(() => backupConfigFile('/tmp/openclaw.json', harness.deps)).not.toThrow();
    expect(harness.copied).toHaveLength(1);
  });
});

describe('writeBaseConfig', () => {
  it('runs onboard targeting tmp file, patches, and renames into place', () => {
    const { deps, written, renamed, execCalls } = fakeDeps();
    writeBaseConfig(minimalEnv(), '/tmp/openclaw.json', deps);

    // Should have called openclaw onboard with correct args
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0].cmd).toBe('openclaw');
    expect(execCalls[0].args).toContain('onboard');
    expect(execCalls[0].args).toContain('--non-interactive');
    expect(execCalls[0].args).toContain('--kilocode-api-key');
    expect(execCalls[0].args).toContain('test-api-key');

    // OPENCLAW_CONFIG_PATH should point to the temp file
    const configPathEnv = execCalls[0].env?.OPENCLAW_CONFIG_PATH;
    expect(configPathEnv).toMatch(/\/tmp\/\.openclaw\.json\.kilotmp\.[0-9a-f]{12}$/);

    // Should write patched config to the same tmp file, then rename to final path
    expect(written).toHaveLength(1);
    expect(written[0].path).toBe(configPathEnv);
    expect(renamed).toHaveLength(1);
    expect(renamed[0].from).toBe(configPathEnv);
    expect(renamed[0].to).toBe('/tmp/openclaw.json');

    // The written data should be valid JSON with our patches applied
    const config = JSON.parse(written[0].data);
    expect(config.gateway.auth.token).toBe('test-gw-token');
    expect(config.tools.exec.host).toBe('gateway');
  });

  it('chmods the temp file to 0o600 before rename (owner-only commit)', () => {
    const { deps, written, renamed, chmodded } = fakeDeps();
    writeBaseConfig(minimalEnv(), '/tmp/openclaw.json', deps);

    // Exactly one chmod and it targets the same temp path that was written,
    // not the final path. Chmod-before-rename keeps the commit atomic: if
    // chmod fails, rename never happens and the target file is untouched.
    expect(chmodded).toHaveLength(1);
    expect(chmodded[0]).toEqual({ path: written[0].path, mode: 0o600 });

    // Rename happens after chmod (asserted by ordering of mock calls: write
    // at index 0, chmod at index 0, rename at index 0 — they each fired
    // exactly once but from different mocks, so arrays remain length-1
    // with the temp path as the subject).
    expect(renamed[0].from).toBe(written[0].path);
    expect(renamed[0].to).toBe('/tmp/openclaw.json');
  });

  it('propagates chmod failure and leaves target config file untouched', () => {
    const { deps } = fakeDeps();
    const chmodError = new Error('chmod failed');
    (deps.chmodSync as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw chmodError;
    });

    expect(() => writeBaseConfig(minimalEnv(), '/tmp/openclaw.json', deps)).toThrow(chmodError);

    // Rename must NOT have happened — the target openclaw.json is untouched
    // by this failed write rather than committed with whatever default-umask
    // mode the temp file ended up with.
    expect(deps.renameSync).not.toHaveBeenCalled();

    // Cleanup was attempted against the temp path
    expect(deps.unlinkSync).toHaveBeenCalled();
  });

  it('passes all required onboard flags for non-interactive setup', () => {
    const { deps, execCalls } = fakeDeps();
    writeBaseConfig(minimalEnv(), '/tmp/openclaw.json', deps);

    const args = execCalls[0].args;
    expect(args).toContain('--accept-risk');
    expect(args).toContain('--mode');
    expect(args[args.indexOf('--mode') + 1]).toBe('local');
    expect(args).toContain('--gateway-port');
    expect(args[args.indexOf('--gateway-port') + 1]).toBe('3001');
    expect(args).toContain('--gateway-bind');
    expect(args[args.indexOf('--gateway-bind') + 1]).toBe('loopback');
    expect(args).toContain('--skip-channels');
    expect(args).toContain('--skip-skills');
    expect(args).toContain('--skip-health');
    expect(args).toContain('--secret-input-mode');
    expect(args[args.indexOf('--secret-input-mode') + 1]).toBe('ref');
  });

  it('forces tools.profile to full even without KILOCLAW_FRESH_INSTALL', () => {
    // writeBaseConfig is used for both fresh installs and config restores.
    // The restore endpoint doesn't set KILOCLAW_FRESH_INSTALL, but the config
    // should still get tools.profile='full' (not the onboard default 'messaging').
    const { deps, written } = fakeDeps();
    const env = minimalEnv();
    // Explicitly unset to simulate the restore endpoint path
    delete env.KILOCLAW_FRESH_INSTALL;
    writeBaseConfig(env, '/tmp/openclaw.json', deps);

    const config = JSON.parse(written[0].data);
    expect(config.tools.profile).toBe('full');
  });

  it('auto-assigns Exa web search provider on restore path when provider is missing', () => {
    const { deps, written } = fakeDeps();
    const env = minimalEnv();
    delete env.KILOCLAW_FRESH_INSTALL;

    writeBaseConfig(env, '/tmp/openclaw.json', deps);

    const config = JSON.parse(written[0].data);
    expect(config.tools?.web?.search?.provider).toBe('kilo-exa');
    expect(config.tools?.web?.search?.enabled).toBe(true);
  });

  it('does not auto-assign Exa web search provider on restore path when BRAVE_API_KEY is configured', () => {
    const { deps, written } = fakeDeps();
    const env: Record<string, string | undefined> = {
      ...minimalEnv(),
      BRAVE_API_KEY: 'BSA' + 'A'.repeat(20),
    };
    delete env.KILOCLAW_FRESH_INSTALL;

    writeBaseConfig(env, '/tmp/openclaw.json', deps);

    const config = JSON.parse(written[0].data);
    expect(config.tools?.web?.search?.provider).toBeUndefined();
  });

  it('throws if KILOCODE_API_KEY is missing', () => {
    const { deps } = fakeDeps();
    const env = { ...minimalEnv() };
    delete env.KILOCODE_API_KEY;

    expect(() => writeBaseConfig(env, '/tmp/openclaw.json', deps)).toThrow(
      'KILOCODE_API_KEY is required'
    );
  });

  it('backs up existing config with timestamp before onboard', () => {
    const existing = JSON.stringify({ old: true });
    const { deps, copied, execCalls } = fakeDeps(existing);
    writeBaseConfig(minimalEnv(), '/tmp/openclaw.json', deps);

    // Backup happens before onboard
    expect(copied).toHaveLength(1);
    expect(copied[0].src).toBe('/tmp/openclaw.json');
    expect(copied[0].dest).toMatch(/\/tmp\/openclaw\.json\.bak\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-/);
    expect(execCalls).toHaveLength(1);
  });

  it('does not back up when no existing config', () => {
    const { deps, copied } = fakeDeps();
    writeBaseConfig(minimalEnv(), '/tmp/openclaw.json', deps);

    expect(copied).toHaveLength(0);
  });

  it('prunes old backups beyond MAX_CONFIG_BACKUPS', () => {
    const existing = JSON.stringify({ old: true });
    const harness = fakeDeps(existing);
    harness.setDirEntries([
      'openclaw.json.bak.2026-02-20T10-00-00.000Z',
      'openclaw.json.bak.2026-02-21T10-00-00.000Z',
      'openclaw.json.bak.2026-02-22T10-00-00.000Z',
      'openclaw.json.bak.2026-02-23T10-00-00.000Z',
      'openclaw.json.bak.2026-02-24T10-00-00.000Z',
      'openclaw.json.bak.2026-02-25T10-00-00.000Z',
      'openclaw.json.bak.2026-02-26T10-00-00.000Z',
    ]);

    writeBaseConfig(minimalEnv(), '/tmp/openclaw.json', harness.deps);

    expect(harness.unlinked).toHaveLength(8 - MAX_CONFIG_BACKUPS);
    expect(harness.unlinked[0]).toBe('/tmp/openclaw.json.bak.2026-02-20T10-00-00.000Z');
    expect(harness.unlinked[1]).toBe('/tmp/openclaw.json.bak.2026-02-21T10-00-00.000Z');
  });

  it('continues if backup pruning fails', () => {
    const existing = JSON.stringify({ old: true });
    const harness = fakeDeps(existing);
    harness.deps.readdirSync.mockImplementation(() => {
      throw new Error('permission denied');
    });

    const config = writeBaseConfig(minimalEnv(), '/tmp/openclaw.json', harness.deps);
    expect(config.gateway.port).toBe(3001);
    expect(harness.written).toHaveLength(1);
    expect(harness.renamed).toHaveLength(1);
  });

  it('cleans up tmp file if onboard fails', () => {
    const harness = fakeDeps();
    harness.deps.execFileSync.mockImplementation(() => {
      throw new Error('openclaw: command not found');
    });

    expect(() => writeBaseConfig(minimalEnv(), '/tmp/openclaw.json', harness.deps)).toThrow(
      'openclaw: command not found'
    );

    // Tmp file cleaned up, nothing written or renamed
    expect(harness.unlinked).toHaveLength(1);
    expect(harness.unlinked[0]).toMatch(/\.kilotmp\./);
    expect(harness.written).toHaveLength(0);
    expect(harness.renamed).toHaveLength(0);
  });

  it('cleans up tmp file if rename fails', () => {
    const harness = fakeDeps();
    harness.deps.renameSync.mockImplementation(() => {
      throw new Error('EXDEV: cross-device link');
    });

    expect(() => writeBaseConfig(minimalEnv(), '/tmp/openclaw.json', harness.deps)).toThrow(
      'EXDEV'
    );

    // Tmp file should have been written then cleaned up
    expect(harness.written).toHaveLength(1);
    expect(harness.unlinked).toHaveLength(1);
    expect(harness.unlinked[0]).toBe(harness.written[0].path);
  });

  it('does not touch existing config if onboard fails', () => {
    const existing = JSON.stringify({ important: 'data' });
    const harness = fakeDeps(existing);
    harness.deps.execFileSync.mockImplementation(() => {
      throw new Error('onboard failed');
    });

    expect(() => writeBaseConfig(minimalEnv(), '/tmp/openclaw.json', harness.deps)).toThrow(
      'onboard failed'
    );

    // Backup was created but existing config was never overwritten
    expect(harness.copied).toHaveLength(1);
    expect(harness.renamed).toHaveLength(0);
  });

  it('returns the generated config object with onboard base + patches', () => {
    const { deps } = fakeDeps();
    const config = writeBaseConfig(minimalEnv(), '/tmp/openclaw.json', deps);

    // From onboard base config
    expect(config.gateway.port).toBe(3001);
    expect(config.gateway.mode).toBe('local');
    // From our patches
    expect(config.gateway.auth.token).toBe('test-gw-token');
    expect(config.tools.exec.host).toBe('gateway');
  });
});

function mcporterFakeDeps(existingMcporterConfig?: string) {
  const written: { path: string; data: string }[] = [];
  return {
    deps: {
      readFileSync: vi.fn((filePath: string) => {
        if (existingMcporterConfig !== undefined) return existingMcporterConfig;
        throw new Error(`ENOENT: no such file: ${filePath}`);
      }),
      writeFileSync: vi.fn((filePath: string, data: string) => {
        written.push({ path: filePath, data });
      }),
      renameSync: vi.fn(),
      chmodSync: vi.fn(),
      copyFileSync: vi.fn(),
      readdirSync: vi.fn(() => []),
      unlinkSync: vi.fn(),
      existsSync: vi.fn((filePath: string) => {
        if (existingMcporterConfig !== undefined && filePath.endsWith('mcporter.json')) return true;
        return false;
      }),
      execFileSync: vi.fn(),
    },
    written,
  };
}

describe('writeMcporterConfig', () => {
  it('adds Linear MCP server when LINEAR_API_KEY is set', () => {
    const { deps, written } = mcporterFakeDeps();
    const env = { LINEAR_API_KEY: 'lin_api_test123' };

    writeMcporterConfig(env, '/tmp/mcporter.json', deps);

    expect(written).toHaveLength(1);
    const config = JSON.parse(written[0].data);
    expect(config.mcpServers.linear).toEqual({
      url: 'https://mcp.linear.app/mcp',
      headers: { Authorization: 'Bearer ${LINEAR_API_KEY}' },
    });
  });

  it('removes Linear MCP server when LINEAR_API_KEY is absent', () => {
    const existing = JSON.stringify({
      mcpServers: {
        linear: {
          url: 'https://mcp.linear.app/mcp',
          headers: { Authorization: 'Bearer ${LINEAR_API_KEY}' },
        },
      },
    });
    const { deps, written } = mcporterFakeDeps(existing);
    const env: Record<string, string | undefined> = {};

    writeMcporterConfig(env, '/tmp/mcporter.json', deps);

    expect(written).toHaveLength(1);
    const config = JSON.parse(written[0].data);
    expect(config.mcpServers.linear).toBeUndefined();
  });

  it('preserves user-added servers when adding Linear', () => {
    const existing = JSON.stringify({
      mcpServers: {
        custom: { url: 'https://custom.example.com/mcp' },
      },
    });
    const { deps, written } = mcporterFakeDeps(existing);
    const env = { LINEAR_API_KEY: 'lin_api_test123' };

    writeMcporterConfig(env, '/tmp/mcporter.json', deps);

    expect(written).toHaveLength(1);
    const config = JSON.parse(written[0].data);
    expect(config.mcpServers.custom).toEqual({ url: 'https://custom.example.com/mcp' });
    expect(config.mcpServers.linear).toBeDefined();
  });

  it('adds both AgentCard and Linear when both keys are set', () => {
    const { deps, written } = mcporterFakeDeps();
    const env = {
      AGENTCARD_API_KEY: 'ac_test123',
      LINEAR_API_KEY: 'lin_api_test123',
    };

    writeMcporterConfig(env, '/tmp/mcporter.json', deps);

    expect(written).toHaveLength(1);
    const config = JSON.parse(written[0].data);
    expect(config.mcpServers.agentcard).toBeDefined();
    expect(config.mcpServers.linear).toBeDefined();
  });

  it('uses literal ${LINEAR_API_KEY} in authorization header (not interpolated)', () => {
    const { deps, written } = mcporterFakeDeps();
    const env = { LINEAR_API_KEY: 'lin_api_test123' };

    writeMcporterConfig(env, '/tmp/mcporter.json', deps);

    const config = JSON.parse(written[0].data);
    // The header should contain the literal string ${LINEAR_API_KEY}, not the actual value
    expect(config.mcpServers.linear.headers.Authorization).toBe('Bearer ${LINEAR_API_KEY}');
  });
});
