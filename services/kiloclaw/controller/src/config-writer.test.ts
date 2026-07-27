import { describe, it, expect, vi } from 'vitest';
import {
  backupConfigFile,
  ensureBootableHookConfig,
  ensureInboundEmailHookFlags,
  generateBaseConfig,
  hookConfigBootViolation,
  repairPersistedHookInvariants,
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

const KILOCODE_PROVIDER_PLUGIN_PATH = '/usr/local/lib/node_modules/@openclaw/kilocode-provider';

function fakeDeps(existingConfig?: string, opts?: { kilocodeProviderInstalled?: boolean }) {
  // Default to a modern (openclaw >= 2026.6.9) image where the externalized
  // kilocode provider plugin is installed on disk. Pass
  // { kilocodeProviderInstalled: false } to simulate a pre-2026.6.9 image.
  const kilocodeProviderInstalled = opts?.kilocodeProviderInstalled ?? true;
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
      mkdirSync: vi.fn(),
      readdirSync: vi.fn(() => dirEntries),
      unlinkSync: vi.fn((filePath: string) => {
        unlinked.push(filePath);
      }),
      existsSync: vi.fn((filePath: string) => {
        if (filePath.endsWith('openclaw.json')) return existingConfig !== undefined;
        if (filePath === KILOCODE_PROVIDER_PLUGIN_PATH) return kilocodeProviderInstalled;
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
  it('generates config with gateway, exec defaults, and a kilocode provider entry that triggers live discovery', () => {
    const { deps } = fakeDeps();
    const config = generateBaseConfig(minimalEnv(), '/tmp/openclaw.json', deps);

    // Gateway
    expect(config.gateway.port).toBe(3001);
    expect(config.gateway.mode).toBe('local');
    expect(config.gateway.bind).toBe('loopback');
    expect(config.gateway.auth.token).toBe('test-gw-token');
    expect(config.gateway.controlUi.allowInsecureAuth).toBe(true);

    // The bundled kilocode plugin only loads when this entry is present.
    // Empty `models` lets live gateway discovery own the catalog.
    expect(config.models.providers.kilocode.baseUrl).toBe('https://api.kilo.ai/api/gateway/');
    expect(config.models.providers.kilocode.api).toBe('openai-completions');
    expect(config.models.providers.kilocode.models).toEqual([]);

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

  it('removes stale kilocode openrouter entry and rebuilds it pointed at the production gateway', () => {
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

    // Stale entry replaced — old apiKey and models dropped, baseUrl pointed
    // at the production gateway so the bundled plugin can load.
    expect(config.models.providers.kilocode.baseUrl).toBe('https://api.kilo.ai/api/gateway/');
    expect(config.models.providers.kilocode.api).toBe('openai-completions');
    expect(config.models.providers.kilocode.models).toEqual([]);
    expect(config.models.providers.kilocode.apiKey).toBeUndefined();
  });

  // Regression: an earlier migration deleted the kilocode provider entry on
  // personal (non-org) instances, expecting the bundled openclaw kilocode
  // plugin to auto-activate from KILOCODE_API_KEY alone. It does not — the
  // plugin only loads when an explicit provider entry is present, so without
  // it `kilo-auto/balanced` and the rest of the dynamic catalog were never
  // discovered and the agent failed with "Unknown model".
  it('keeps kilocode provider entry on personal instances (no KILOCODE_ORGANIZATION_ID) so the bundled plugin loads', () => {
    const { deps } = fakeDeps();
    const env = {
      ...minimalEnv(),
      KILOCODE_DEFAULT_MODEL: 'kilocode/kilo-auto/balanced',
    };
    const config = generateBaseConfig(env, '/tmp/openclaw.json', deps);

    expect(config.models.providers.kilocode.baseUrl).toBe('https://api.kilo.ai/api/gateway/');
    expect(config.models.providers.kilocode.api).toBe('openai-completions');
    expect(config.models.providers.kilocode.models).toEqual([]);
    expect(config.models.providers.kilocode.headers?.['X-KiloCode-OrganizationId']).toBeUndefined();
    expect(config.agents.defaults.model.primary).toBe('kilocode/kilo-auto/balanced');
  });

  it('preserves kilocode provider with production /api/gateway/ baseUrl and clears stale models', () => {
    const existing = JSON.stringify({
      models: {
        providers: {
          kilocode: {
            baseUrl: 'https://api.kilo.ai/api/gateway/',
            api: 'openai-completions',
            models: [{ id: 'kilo/auto', name: 'Kilo Auto' }],
          },
        },
      },
    });
    const { deps } = fakeDeps(existing);
    const config = generateBaseConfig(minimalEnv(), '/tmp/openclaw.json', deps);

    // Entry preserved (so the plugin loads), stale onboard-written models
    // cleared so live discovery owns the catalog.
    expect(config.models.providers.kilocode.baseUrl).toBe('https://api.kilo.ai/api/gateway/');
    expect(config.models.providers.kilocode.api).toBe('openai-completions');
    expect(config.models.providers.kilocode.models).toEqual([]);
  });

  // Auth must come from `KILOCODE_API_KEY` env, never from a literal `apiKey`
  // field on disk. The previous deletion-based migration was incidentally
  // scrubbing the field; this test pins that the new normalization keeps that
  // scrub so a stale plaintext credential from a legacy onboard run cannot
  // survive across boots.
  it('scrubs a stale plaintext apiKey from the kilocode provider entry', () => {
    const existing = JSON.stringify({
      models: {
        providers: {
          kilocode: {
            baseUrl: 'https://api.kilo.ai/api/gateway/',
            api: 'openai-completions',
            apiKey: 'sk-stale-plaintext',
            models: [],
          },
        },
      },
    });
    const { deps } = fakeDeps(existing);
    const config = generateBaseConfig(minimalEnv(), '/tmp/openclaw.json', deps);

    expect(config.models.providers.kilocode.apiKey).toBeUndefined();
    expect(config.models.providers.kilocode.baseUrl).toBe('https://api.kilo.ai/api/gateway/');
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

  it('preserves non-kilocode providers when rebuilding stale kilocode openrouter entry', () => {
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

    // openai preserved, kilocode rebuilt with production gateway URL
    expect(config.models.providers.openai.baseUrl).toBe('https://api.openai.com/v1');
    expect(config.models.providers.kilocode.baseUrl).toBe('https://api.kilo.ai/api/gateway/');
  });

  it('creates kilocode provider with baseUrl and models: [] when KILOCODE_API_BASE_URL is set', () => {
    const { deps } = fakeDeps();
    const env = { ...minimalEnv(), KILOCODE_API_BASE_URL: 'https://tunnel.example.com/' };
    const config = generateBaseConfig(env, '/tmp/openclaw.json', deps);

    expect(config.models.providers.kilocode.baseUrl).toBe('https://tunnel.example.com/');
    expect(config.models.providers.kilocode.models).toEqual([]);
  });

  it('clears stale models when overriding baseUrl, since live discovery owns the catalog', () => {
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

    // baseUrl updated, stale onboard-written models cleared so live
    // discovery populates the catalog from the new endpoint.
    expect(config.models.providers.kilocode.baseUrl).toBe('https://new-tunnel.example.com/');
    expect(config.models.providers.kilocode.models).toEqual([]);
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

    // Personal instance: kilocode entry still present (the bundled plugin
    // requires it to load), but no org header attached.
    expect(config.models.providers.kilocode.baseUrl).toBe('https://api.kilo.ai/api/gateway/');
    expect(config.models.providers.kilocode.headers?.['X-KiloCode-OrganizationId']).toBeUndefined();
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
    // models cleared so live discovery from the (preserved) baseUrl owns the catalog
    expect(config.models.providers.kilocode.models).toEqual([]);
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

  it('passes allowed origins entries through as literal strings', () => {
    // The config-writer does not interpret entries — whatever openclaw's
    // origin check understands (exact matches and bare `*`) is what matters.
    // Per-instance virtual hosting is implemented by the worker appending a
    // specific `https://<instanceId>.kiloclaw.ai` entry to the list before it
    // reaches the controller (see services/kiloclaw/src/gateway/env.ts), not
    // by using a wildcard host pattern here. A wildcard entry would be kept
    // in the config but would never match a real Origin header.
    const { deps } = fakeDeps();
    const env = {
      ...minimalEnv(),
      OPENCLAW_ALLOWED_ORIGINS:
        'https://claw.kilosessions.ai, https://abc.kiloclaw.ai, https://kilo.ai',
    };
    const config = generateBaseConfig(env, '/tmp/openclaw.json', deps);

    expect(config.gateway.controlUi.allowedOrigins).toEqual([
      'https://claw.kilosessions.ai',
      'https://abc.kiloclaw.ai',
      'https://kilo.ai',
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

  it('updates managed plugins in an existing plugin allowlist', () => {
    const existing = JSON.stringify({
      channels: {
        streamchat: { enabled: true },
      },
      plugins: {
        load: {
          paths: [
            '/usr/local/lib/node_modules/@wunderchat/openclaw-channel-streamchat',
            '/usr/local/lib/node_modules/@kiloclaw/kiloclaw-customizer',
          ],
        },
        allow: ['openclaw-channel-streamchat', 'telegram', 'kilocode', 'browser'],
        entries: {
          'openclaw-channel-streamchat': { enabled: true },
        },
      },
    });
    const { deps } = fakeDeps(existing);
    const config = generateBaseConfig(minimalEnv(), '/tmp/openclaw.json', deps);

    expect(config.channels.streamchat).toBeUndefined();
    expect(config.plugins.load.paths).not.toContain(
      '/usr/local/lib/node_modules/@wunderchat/openclaw-channel-streamchat'
    );
    expect(config.plugins.entries).not.toHaveProperty('openclaw-channel-streamchat');
    expect(config.plugins.allow).not.toContain('openclaw-channel-streamchat');
    expect(config.plugins.allow).toContain('kiloclaw-customizer');
    expect(config.plugins.allow).toContain('kiloclaw-morning-briefing');
    expect(config.plugins.allow).toContain('kilo-chat');
  });

  it('loads the externalized kilocode provider plugin via plugins.load.paths', () => {
    const { deps } = fakeDeps();
    const config = generateBaseConfig(minimalEnv(), '/tmp/openclaw.json', deps);

    // openclaw #93470 externalized the kilocode provider; it is no longer bundled
    // and must be loaded explicitly by path or model routing breaks.
    expect(config.plugins.load.paths).toContain(
      '/usr/local/lib/node_modules/@openclaw/kilocode-provider'
    );
  });

  it('adds kilocode to an existing plugin allowlist that does not include it', () => {
    // Regression guard: the append-when-missing branch for the kilocode provider.
    // The managed-allowlist test above pre-seeds 'kilocode', so it never exercises
    // this path; start from an allowlist WITHOUT it.
    const existing = JSON.stringify({
      plugins: {
        load: { paths: [] },
        allow: ['telegram', 'browser'],
      },
    });
    const { deps } = fakeDeps(existing);
    const config = generateBaseConfig(minimalEnv(), '/tmp/openclaw.json', deps);

    expect(config.plugins.allow).toContain('kilocode');
    expect(config.plugins.load.paths).toContain(
      '/usr/local/lib/node_modules/@openclaw/kilocode-provider'
    );
  });

  it('does not duplicate the kilocode provider plugin path on repeated generateBaseConfig calls', () => {
    const providerPath = '/usr/local/lib/node_modules/@openclaw/kilocode-provider';
    const existing = JSON.stringify({
      plugins: {
        load: { paths: [providerPath] },
        allow: ['kilocode'],
      },
    });
    const { deps } = fakeDeps(existing);
    const config = generateBaseConfig(minimalEnv(), '/tmp/openclaw.json', deps);

    const paths = config.plugins.load.paths as string[];
    expect(paths.filter(p => p === providerPath)).toHaveLength(1);
    expect((config.plugins.allow as string[]).filter(a => a === 'kilocode')).toHaveLength(1);
  });

  it('does NOT add the kilocode provider plugin path on a pre-2026.6.9 image where the plugin is not installed', () => {
    // Older openclaw versions are still selectable at provision time; the
    // provider is in-core and no plugin file exists. Adding a non-existent
    // plugin path fails openclaw config validation and prevents the gateway
    // from starting, so the controller must omit it.
    const { deps } = fakeDeps(undefined, { kilocodeProviderInstalled: false });
    const config = generateBaseConfig(minimalEnv(), '/tmp/openclaw.json', deps);

    expect(config.plugins.load.paths).not.toContain(KILOCODE_PROVIDER_PLUGIN_PATH);
    // The in-core provider still activates from the models.providers.kilocode
    // entry, so that must remain regardless of plugin externalization.
    expect(config.models.providers.kilocode.baseUrl).toBe('https://api.kilo.ai/api/gateway/');
    // The always-present customizer plugin path is unaffected.
    expect(config.plugins.load.paths).toContain(
      '/usr/local/lib/node_modules/@kiloclaw/kiloclaw-customizer'
    );
  });

  it('prunes a stale kilocode provider plugin path when downgraded to a pre-2026.6.9 image', () => {
    // Migration case: an instance whose persisted openclaw.json still carries
    // the provider path (written on a >= 2026.6.9 image) is reprovisioned /
    // downgraded onto an older openclaw where the plugin is absent. The path
    // must be actively removed so the gateway can start again.
    const existing = JSON.stringify({
      plugins: {
        load: {
          paths: [
            KILOCODE_PROVIDER_PLUGIN_PATH,
            '/usr/local/lib/node_modules/@kiloclaw/kiloclaw-customizer',
          ],
        },
        allow: ['kilocode'],
      },
    });
    const { deps } = fakeDeps(existing, { kilocodeProviderInstalled: false });
    const config = generateBaseConfig(minimalEnv(), '/tmp/openclaw.json', deps);

    expect(config.plugins.load.paths).not.toContain(KILOCODE_PROVIDER_PLUGIN_PATH);
    // Unrelated plugin paths survive the prune.
    expect(config.plugins.load.paths).toContain(
      '/usr/local/lib/node_modules/@kiloclaw/kiloclaw-customizer'
    );
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

  // ─── Kilo Chat ───────────────────────────────────────────────────────────

  it('always configures kilo-chat channel and plugin', () => {
    const { deps } = fakeDeps();
    const config = generateBaseConfig(minimalEnv(), '/tmp/openclaw.json', deps);

    expect(config.channels['kilo-chat'].enabled).toBe(true);
    // _configured provides the non-`enabled` key required by OpenClaw's
    // hasMeaningfulChannelConfig gate (see comment in config-writer.ts).
    expect(config.channels['kilo-chat']._configured).toBe(true);
    expect(config.channels['kilo-chat']).not.toHaveProperty('reactionLevel');
    expect(config.plugins.load.paths).toContain('/usr/local/lib/node_modules/@kiloclaw/kilo-chat');
    expect(config.plugins.entries['kilo-chat'].enabled).toBe(true);
  });

  // ─── Session ─────────────────────────────────────────────────────────────

  it('defaults session.dmScope to per-channel-peer', () => {
    const { deps } = fakeDeps();
    const config = generateBaseConfig(minimalEnv(), '/tmp/openclaw.json', deps);

    expect(config.session.dmScope).toBe('per-channel-peer');
  });

  it('preserves existing session.dmScope', () => {
    const existing = JSON.stringify({
      gateway: { port: 3001, mode: 'local' },
      agents: { defaults: { model: { primary: 'kilocode/anthropic/claude-opus-4.6' } } },
      session: { dmScope: 'per-peer' },
      plugins: { entries: { telegram: { enabled: false }, discord: { enabled: false } } },
    });
    const { deps } = fakeDeps(existing);
    const config = generateBaseConfig(minimalEnv(), '/tmp/openclaw.json', deps);

    expect(config.session.dmScope).toBe('per-peer');
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
    expect(config.hooks.allowRequestSessionKey).toBe(true);
    expect(config.hooks.allowedSessionKeyPrefixes).toEqual(['hook:', 'inbound-email:']);
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
    expect(config.hooks.allowedSessionKeyPrefixes).toEqual(['hook:', 'inbound-email:']);
  });

  it('preserves existing hook session key prefixes without duplicating inbound email', () => {
    const existing = JSON.stringify({
      hooks: { allowedSessionKeyPrefixes: ['custom:', 'hook:', 'inbound-email:'] },
    });
    const { deps } = fakeDeps(existing);
    const env = { ...minimalEnv(), KILOCLAW_HOOKS_TOKEN: 'test-hooks-token' };
    const config = generateBaseConfig(env, '/tmp/openclaw.json', deps);

    expect(config.hooks.allowedSessionKeyPrefixes).toEqual(['custom:', 'hook:', 'inbound-email:']);
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

describe('ensureInboundEmailHookFlags', () => {
  it('sets allowRequestSessionKey on a hooks object that lacks it', () => {
    const config = { hooks: { enabled: true, token: 'tok' } };
    ensureInboundEmailHookFlags(config);
    expect(config.hooks).toMatchObject({
      enabled: true,
      token: 'tok',
      allowRequestSessionKey: true,
    });
  });

  it('is a no-op when hooks block is absent (instance has no inbound hooks)', () => {
    const config: Record<string, unknown> = { gateway: {} };
    ensureInboundEmailHookFlags(config);
    expect(config.hooks).toBeUndefined();
  });

  it('is idempotent when allowRequestSessionKey is already true', () => {
    const config = { hooks: { allowRequestSessionKey: true } };
    ensureInboundEmailHookFlags(config);
    expect(config.hooks.allowRequestSessionKey).toBe(true);
  });

  it('overrides allowRequestSessionKey: false back to true', () => {
    // Canonical-config policy: the inbound-email mapping is force-installed
    // on every run, so the flag it requires must converge to true alongside
    // it. An explicit `false` is treated as drift, not as admin intent.
    const config = { hooks: { allowRequestSessionKey: false } };
    ensureInboundEmailHookFlags(config);
    expect(config.hooks.allowRequestSessionKey).toBe(true);
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
      mkdirSync: vi.fn(),
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

describe('Composio Connect MCP server', () => {
  const KEY = 'ck_FAKE_TEST_KEY_1234567890';

  function composioServer(config: Record<string, any>) {
    return config.mcp?.servers?.composio;
  }

  it('registers the remote server with the consumer key header when the key is set', () => {
    const { deps } = fakeDeps();
    const config = generateBaseConfig(
      { ...minimalEnv(), COMPOSIO_CONSUMER_KEY: KEY },
      '/tmp/openclaw.json',
      deps
    );

    expect(composioServer(config)).toEqual({
      kiloclawManaged: true,
      transport: 'streamable-http',
      url: 'https://connect.composio.dev/mcp',
      headers: { 'x-consumer-api-key': KEY },
    });
  });

  it('does not define the server when no key is configured', () => {
    const { deps } = fakeDeps();
    const config = generateBaseConfig(minimalEnv(), '/tmp/openclaw.json', deps);

    expect(composioServer(config)).toBeUndefined();
  });

  it('trims surrounding whitespace off a pasted key', () => {
    const { deps } = fakeDeps();
    const config = generateBaseConfig(
      { ...minimalEnv(), COMPOSIO_CONSUMER_KEY: `  ${KEY}  ` },
      '/tmp/openclaw.json',
      deps
    );

    expect(composioServer(config).headers).toEqual({ 'x-consumer-api-key': KEY });
  });

  it('replaces a stale key on the next boot', () => {
    const existing = JSON.stringify({
      mcp: {
        servers: {
          composio: {
            kiloclawManaged: true,
            transport: 'streamable-http',
            url: 'https://connect.composio.dev/mcp',
            headers: { 'x-consumer-api-key': 'ck_OLD_KEY_0987654321' },
          },
        },
      },
    });
    const { deps } = fakeDeps(existing);
    const config = generateBaseConfig(
      { ...minimalEnv(), COMPOSIO_CONSUMER_KEY: KEY },
      '/tmp/openclaw.json',
      deps
    );

    expect(composioServer(config).headers).toEqual({ 'x-consumer-api-key': KEY });
  });

  // Taking over an existing definition must not inherit its connection fields.
  it('replaces a hand-rolled stdio server outright rather than merging into it', () => {
    const { deps } = fakeDeps(
      JSON.stringify({
        mcp: {
          servers: {
            composio: { transport: 'stdio', command: 'composio', args: ['mcp', 'serve'] },
          },
        },
      })
    );
    const config = generateBaseConfig(
      { ...minimalEnv(), COMPOSIO_CONSUMER_KEY: KEY },
      '/tmp/openclaw.json',
      deps
    );

    expect(composioServer(config)).toEqual({
      kiloclawManaged: true,
      transport: 'streamable-http',
      url: 'https://connect.composio.dev/mcp',
      headers: { 'x-consumer-api-key': KEY },
    });
  });

  // A surviving `auth: 'oauth'` makes OpenClaw drop request headers entirely,
  // so the pasted key would authenticate nothing and report no error.
  it('drops a pre-existing oauth mode so the consumer key header is actually sent', () => {
    const { deps } = fakeDeps(
      JSON.stringify({
        mcp: {
          servers: {
            composio: {
              transport: 'streamable-http',
              url: 'https://connect.composio.dev/mcp',
              auth: 'oauth',
            },
          },
        },
      })
    );
    const config = generateBaseConfig(
      { ...minimalEnv(), COMPOSIO_CONSUMER_KEY: KEY },
      '/tmp/openclaw.json',
      deps
    );

    expect(composioServer(config).auth).toBeUndefined();
    expect(composioServer(config).headers).toEqual({ 'x-consumer-api-key': KEY });
  });

  // openclaw.json lives on the volume, so removing the credential in Settings
  // only revokes access if the server definition goes with it.
  it('removes its own server definition once the key is cleared', () => {
    const existing = JSON.stringify({
      mcp: {
        servers: {
          composio: {
            kiloclawManaged: true,
            transport: 'streamable-http',
            url: 'https://connect.composio.dev/mcp',
            headers: { 'x-consumer-api-key': KEY },
          },
          other: { url: 'https://mcp.example.com/mcp' },
        },
      },
    });
    const { deps } = fakeDeps(existing);
    const config = generateBaseConfig(minimalEnv(), '/tmp/openclaw.json', deps);

    expect(composioServer(config)).toBeUndefined();
    expect(config.mcp.servers.other).toEqual({ url: 'https://mcp.example.com/mcp' });
  });

  // The rollout hazard: before this feature, the only way to use Composio
  // Connect was to configure it by hand — same URL, same header, no marker.
  // The first boot after rollout, before the user fills in the new Settings
  // field, must not delete that working server.
  it('leaves an unmarked Composio Connect server (same URL and header) alone when no key is set', () => {
    const handConfigured = {
      transport: 'streamable-http',
      url: 'https://connect.composio.dev/mcp',
      headers: { 'x-consumer-api-key': 'ck_users_own_key_123456' },
    };
    const { deps } = fakeDeps(JSON.stringify({ mcp: { servers: { composio: handConfigured } } }));
    const config = generateBaseConfig(minimalEnv(), '/tmp/openclaw.json', deps);

    expect(composioServer(config)).toEqual(handConfigured);
  });

  // Users wired Composio up by hand long before this field existed. Their
  // config is not ours to delete.
  it('leaves a hand-rolled composio server alone when no key is configured', () => {
    const handRolled = {
      transport: 'stdio',
      command: 'composio',
      args: ['mcp', 'serve'],
    };
    const { deps } = fakeDeps(JSON.stringify({ mcp: { servers: { composio: handRolled } } }));
    const config = generateBaseConfig(minimalEnv(), '/tmp/openclaw.json', deps);

    expect(composioServer(config)).toEqual(handRolled);
  });

  it('leaves a differently-authenticated remote composio server alone', () => {
    const oauthServer = {
      transport: 'streamable-http',
      url: 'https://connect.composio.dev/mcp',
      auth: 'oauth',
    };
    const { deps } = fakeDeps(JSON.stringify({ mcp: { servers: { composio: oauthServer } } }));
    const config = generateBaseConfig(minimalEnv(), '/tmp/openclaw.json', deps);

    expect(composioServer(config)).toEqual(oauthServer);
  });
});

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

/** Config shaped like the one that bricked a live instance: templated hook
 * sessionKey, `allowRequestSessionKey` set, but no prefix allow-list. */
// Mirrors the untyped shape of openclaw.json so cases can break one field at a
// time without fighting inferred literal types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ConfigLike = { hooks: Record<string, any> };

function bootBlockingConfig(): ConfigLike {
  return {
    hooks: {
      enabled: true,
      token: 'local-token',
      path: '/hooks',
      allowRequestSessionKey: true,
      mappings: [
        {
          id: 'cloudflare-email-inbound',
          action: 'agent',
          sessionKey: '{{payload.sessionKey}}',
        },
      ],
    },
  };
}

/** Builds a hooks block that is startable, so each case can break one thing. */
function healthyHookConfig(): ConfigLike {
  return {
    hooks: {
      enabled: true,
      token: 'local-token',
      path: '/hooks',
      mappings: [{ id: 'static', action: 'agent', sessionKey: 'hook:fixed' }],
    },
  };
}

/**
 * Every way OpenClaw's resolveHooksConfig refuses to start, keyed to the throw
 * it mirrors. Used to drive both the detector and the repair.
 */
const BOOT_BLOCKING_CASES: { name: string; expect: RegExp; build: () => ConfigLike }[] = [
  {
    name: 'hooks.enabled with no token',
    expect: /hooks\.enabled requires hooks\.token/,
    build: () => {
      const config = healthyHookConfig();
      delete config.hooks.token;
      return config;
    },
  },
  {
    name: "hooks.path of '/'",
    expect: /hooks\.path may not be/,
    build: () => {
      const config = healthyHookConfig();
      config.hooks.path = '/';
      return config;
    },
  },
  {
    name: 'defaultSessionKey matching no configured prefix',
    expect: /hooks\.defaultSessionKey must match/,
    build: () => {
      const config = healthyHookConfig();
      config.hooks.defaultSessionKey = 'custom:abc';
      config.hooks.allowedSessionKeyPrefixes = ['hook:'];
      return config;
    },
  },
  {
    name: "prefixes without 'hook:' and no defaultSessionKey",
    expect: /must include 'hook:'/,
    build: () => {
      const config = healthyHookConfig();
      config.hooks.allowedSessionKeyPrefixes = ['inbound-email:'];
      return config;
    },
  },
  {
    name: 'templated sessionKey with no prefixes',
    expect: /hooks\.allowedSessionKeyPrefixes is required/,
    build: bootBlockingConfig,
  },
];

describe('hookConfigBootViolation', () => {
  it.each(BOOT_BLOCKING_CASES)('reports $name', ({ build, expect: pattern }) => {
    expect(hookConfigBootViolation(build())).toMatch(pattern);
  });

  it('accepts a startable hook config', () => {
    expect(hookConfigBootViolation(healthyHookConfig())).toBeNull();
  });

  it('treats a blank-only allow-list as absent, matching OpenClaw', () => {
    const config = bootBlockingConfig();
    config.hooks.allowedSessionKeyPrefixes = ['   '];
    expect(hookConfigBootViolation(config)).not.toBeNull();
  });

  it.each(BOOT_BLOCKING_CASES)('ignores $name when hooks are disabled', ({ build }) => {
    const config = build();
    config.hooks.enabled = false;
    expect(hookConfigBootViolation(config)).toBeNull();
  });

  it('ignores configs with no hooks block', () => {
    expect(hookConfigBootViolation({ gateway: { port: 3001 } })).toBeNull();
  });

  // Parity with hasEffectiveTemplatedHookSessionKeyMapping. Each of these is a
  // mapping OpenClaw does NOT treat as templated, so requiring prefixes for
  // them would reject configs the gateway starts from.
  it.each([
    {
      name: 'a non-agent action',
      mapping: { id: 'x', action: 'wake', sessionKey: '{{payload.sessionKey}}' },
    },
    { name: 'an unclosed template', mapping: { id: 'x', sessionKey: 'literal{{' } },
    { name: 'an empty template', mapping: { id: 'x', sessionKey: '{{}}' } },
  ])('does not treat $name as templated', ({ mapping }) => {
    const config = healthyHookConfig();
    config.hooks.mappings = [mapping];
    expect(hookConfigBootViolation(config)).toBeNull();
  });

  // The mapping sessionKey is attacker-influenced and re-checked on every gateway
  // spawn, so template detection must stay linear. OpenClaw's own regex spends
  // ~6s on this input; ours must not, or one crafted mapping stalls every restart.
  it('detects templates in linear time on an unterminated expression', () => {
    const config = healthyHookConfig();
    config.hooks.mappings = [{ id: 'x', sessionKey: `{{${' '.repeat(5000)}a` }];

    const startedAt = Date.now();
    expect(hookConfigBootViolation(config)).toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });

  // Parity guard: OpenClaw's regex accepts a whitespace-only interior, so a
  // "tighten the pattern" change that rejects these would stop us repairing a
  // config the gateway does treat as templated.
  it.each(['{{ }}', '{{  }}'])('treats %j as templated, as OpenClaw does', sessionKey => {
    const config = healthyHookConfig();
    config.hooks.mappings = [{ id: 'x', sessionKey }];
    expect(hookConfigBootViolation(config)).toMatch(/allowedSessionKeyPrefixes is required/);
  });

  it('treats a mapping with no explicit action as an agent mapping', () => {
    const config = healthyHookConfig();
    // action defaults to 'agent' in OpenClaw, so this one does require prefixes.
    config.hooks.mappings = [{ id: 'x', sessionKey: '{{payload.sessionKey}}' }];
    expect(hookConfigBootViolation(config)).toMatch(/allowedSessionKeyPrefixes is required/);
  });

  it('skips a templated mapping shadowed by an earlier catch-all', () => {
    const config = healthyHookConfig();
    config.hooks.mappings = [
      // No matchPath/matchSource — shadows everything after it.
      { id: 'catch-all', sessionKey: 'hook:fixed' },
      { id: 'shadowed', sessionKey: '{{payload.sessionKey}}' },
    ];
    expect(hookConfigBootViolation(config)).toBeNull();
  });

  it('still flags a templated mapping that an earlier narrower mapping cannot shadow', () => {
    const config = healthyHookConfig();
    config.hooks.mappings = [
      { id: 'narrow', match: { path: 'other' }, sessionKey: 'hook:fixed' },
      { id: 'templated', match: { path: 'email' }, sessionKey: '{{payload.sessionKey}}' },
    ];
    expect(hookConfigBootViolation(config)).toMatch(/allowedSessionKeyPrefixes is required/);
  });

  // Parity with openclaw 2026.6.11's resolveHooksConfig, which rejects only a
  // literal '/'. Its trailing-slash strip is greedy, so '//' reduces to '' and
  // is accepted; blanks fall back to the default. Flagging these would reject
  // configs the gateway starts from, so the accepted cases are pinned here to
  // stop a well-meaning "all-slash paths are invalid" change.
  it.each([
    { path: '/', rejected: true },
    { path: '//', rejected: false },
    { path: '///', rejected: false },
    { path: '   ', rejected: false },
    { path: '/hooks', rejected: false },
    { path: 'hooks', rejected: false },
  ])('treats hooks.path $path as rejected=$rejected, matching OpenClaw', ({ path, rejected }) => {
    const config = healthyHookConfig();
    config.hooks.path = path;

    const violation = hookConfigBootViolation(config);
    if (rejected) {
      expect(violation).toMatch(/hooks\.path may not be/);
    } else {
      expect(violation).toBeNull();
    }
  });
});

describe('ensureBootableHookConfig', () => {
  // The property that matters: whatever the repair does, the result must be
  // something OpenClaw will actually start from.
  it.each(BOOT_BLOCKING_CASES)('repairs $name into a startable config', ({ build }) => {
    const config = build();
    const applied = ensureBootableHookConfig(config, { KILOCLAW_HOOKS_TOKEN: 'env-token' });

    expect(applied.length).toBeGreaterThan(0);
    expect(hookConfigBootViolation(config)).toBeNull();
  });

  it.each(BOOT_BLOCKING_CASES)('is idempotent for $name', ({ build }) => {
    const config = build();
    ensureBootableHookConfig(config, { KILOCLAW_HOOKS_TOKEN: 'env-token' });
    expect(ensureBootableHookConfig(config, { KILOCLAW_HOOKS_TOKEN: 'env-token' })).toEqual([]);
  });

  it('restores a missing token from the environment', () => {
    const config = healthyHookConfig();
    delete config.hooks.token;

    const applied = ensureBootableHookConfig(config, { KILOCLAW_HOOKS_TOKEN: 'env-token' });

    expect(config.hooks.token).toBe('env-token');
    expect(config.hooks.enabled).toBe(true);
    expect(applied.join()).toMatch(/restored hooks\.token/);
  });

  it('disables hooks when no token exists anywhere, rather than leaving it unbootable', () => {
    const config = healthyHookConfig();
    delete config.hooks.token;

    const applied = ensureBootableHookConfig(config, {});

    // A disabled hook surface still boots; bootstrap re-enables it next start.
    expect(config.hooks.enabled).toBe(false);
    expect(applied.join()).toMatch(/disabled hooks/);
    expect(hookConfigBootViolation(config)).toBeNull();
  });

  it("resets a '/' path to the default rather than guessing", () => {
    const config = healthyHookConfig();
    config.hooks.path = '/';

    ensureBootableHookConfig(config, {});
    expect(config.hooks.path).toBe('/hooks');
  });

  // The repair must not touch paths OpenClaw accepts, or it would rewrite a
  // working config on every gateway spawn.
  it.each(['//', '///', '   ', '/hooks', 'hooks'])(
    'leaves the OpenClaw-accepted path %j alone',
    path => {
      const config = healthyHookConfig();
      config.hooks.path = path;

      expect(ensureBootableHookConfig(config, {})).toEqual([]);
      expect(config.hooks.path).toBe(path);
    }
  );

  it('keeps the operator defaultSessionKey by allowing it as its own prefix', () => {
    const config = healthyHookConfig();
    config.hooks.defaultSessionKey = 'custom:abc';
    config.hooks.allowedSessionKeyPrefixes = ['hook:'];

    ensureBootableHookConfig(config, {});

    expect(config.hooks.defaultSessionKey).toBe('custom:abc');
    expect(config.hooks.allowedSessionKeyPrefixes).toEqual(['hook:', 'custom:abc']);
  });

  it('adds the required prefixes when a mapping sessionKey is templated', () => {
    const config = bootBlockingConfig();
    expect(ensureBootableHookConfig(config, {})).not.toEqual([]);
    expect(config.hooks.allowedSessionKeyPrefixes).toEqual(['hook:', 'inbound-email:']);
  });

  it('preserves operator-added prefixes while appending the required ones', () => {
    const config = bootBlockingConfig();
    config.hooks.allowedSessionKeyPrefixes = ['custom:'];
    expect(ensureBootableHookConfig(config, {})).not.toEqual([]);
    expect(config.hooks.allowedSessionKeyPrefixes).toEqual(['custom:', 'hook:', 'inbound-email:']);
  });

  it('leaves a startable config untouched', () => {
    const config = healthyHookConfig();
    expect(ensureBootableHookConfig(config, {})).toEqual([]);
    expect(config.hooks).not.toHaveProperty('allowedSessionKeyPrefixes');
  });

  it('ignores configs with no hooks block', () => {
    expect(ensureBootableHookConfig({ gateway: { port: 3001 } }, {})).toEqual([]);
  });

  it('leaves a disabled hook surface alone', () => {
    const config = bootBlockingConfig();
    config.hooks.enabled = false;
    expect(ensureBootableHookConfig(config, {})).toEqual([]);
  });
});

describe('repairPersistedHookInvariants', () => {
  it('rewrites a bricking config and reports the repair', () => {
    const { deps, written, renamed, chmodded } = fakeDeps(JSON.stringify(bootBlockingConfig()));

    expect(repairPersistedHookInvariants('/root/.openclaw/openclaw.json', deps)).toBe(true);

    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0].data).hooks.allowedSessionKeyPrefixes).toEqual([
      'hook:',
      'inbound-email:',
    ]);
    // Written to a temp path, tightened, then renamed over the live config.
    expect(written[0].path).not.toBe('/root/.openclaw/openclaw.json');
    expect(chmodded[0].mode).toBe(0o600);
    expect(renamed[0].to).toBe('/root/.openclaw/openclaw.json');
  });

  it('does not rewrite a config that is already valid', () => {
    const config = bootBlockingConfig();
    ensureBootableHookConfig(config);
    const { deps, written } = fakeDeps(JSON.stringify(config));

    expect(repairPersistedHookInvariants('/root/.openclaw/openclaw.json', deps)).toBe(false);
    expect(written).toHaveLength(0);
  });

  it('returns false instead of throwing when the config is unreadable', () => {
    const { deps, written } = fakeDeps('{ not json');

    expect(repairPersistedHookInvariants('/root/.openclaw/openclaw.json', deps)).toBe(false);
    expect(written).toHaveLength(0);
  });

  it('returns false when there is no config yet', () => {
    const { deps } = fakeDeps();
    expect(repairPersistedHookInvariants('/root/.openclaw/openclaw.json', deps)).toBe(false);
  });

  it('cleans up the temp file when the rename fails', () => {
    const { deps, unlinked } = fakeDeps(JSON.stringify(bootBlockingConfig()));
    deps.renameSync = vi.fn(() => {
      throw new Error('EXDEV');
    });

    expect(repairPersistedHookInvariants('/root/.openclaw/openclaw.json', deps)).toBe(false);
    expect(unlinked).toHaveLength(1);
    expect(unlinked[0]).toContain('.kilorepair.');
  });
});

describe('repairPersistedHookInvariants concurrency', () => {
  it('abandons the repair when the config changed under it', () => {
    const { deps, written, renamed, unlinked } = fakeDeps(JSON.stringify(bootBlockingConfig()));
    let reads = 0;
    deps.readFileSync = vi.fn(() => {
      reads += 1;
      // First read returns the bricking config; the re-read before rename
      // simulates an admin write landing mid-repair.
      return reads === 1
        ? JSON.stringify(bootBlockingConfig())
        : JSON.stringify({ hooks: { enabled: true, mappings: [], adminEdit: true } });
    });

    expect(repairPersistedHookInvariants('/root/.openclaw/openclaw.json', deps)).toBe(false);

    // Staged, then discarded — the admin's write is left intact.
    expect(written).toHaveLength(1);
    expect(renamed).toHaveLength(0);
    expect(unlinked).toHaveLength(1);
  });

  it('completes the repair when the config is untouched', () => {
    const { deps, renamed } = fakeDeps(JSON.stringify(bootBlockingConfig()));

    expect(repairPersistedHookInvariants('/root/.openclaw/openclaw.json', deps)).toBe(true);
    expect(renamed).toHaveLength(1);
  });
});
