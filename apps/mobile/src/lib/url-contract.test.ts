// eslint-disable-next-line import/no-nodejs-modules -- vitest-only guard, runs in node, never bundled into the app
import { readFileSync } from 'node:fs';
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only guard, runs in node, never bundled into the app
import { fileURLToPath } from 'node:url';

import { type ExpoConfig } from 'expo/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertProductionHost,
  assertUrlScheme,
  LATENCY_INGEST_URL_DEFAULT,
  PRODUCTION_HOSTS,
  URL_SCHEMES,
} from '@/lib/url-contract';
import { ENV_KEYS, OPTIONAL_ENV_KEYS } from './env-keys';

describe('assertUrlScheme', () => {
  const productionCases: { key: keyof typeof URL_SCHEMES; value: string }[] = [
    { key: 'apiBaseUrl', value: 'https://api.kilo.ai' },
    { key: 'webBaseUrl', value: 'https://app.kilo.ai' },
    { key: 'notificationsUrl', value: 'https://notifications.kilo.ai' },
    { key: 'cloudAgentWsUrl', value: 'wss://cloud-agent.kilo.ai' },
    { key: 'sessionIngestWsUrl', value: 'wss://session-ingest.kilo.ai' },
    { key: 'eventServiceUrl', value: 'https://events.kilo.ai' },
    { key: 'latencyIngestUrl', value: 'https://latency.kiloapps.io' },
  ];

  it('accepts each URL key with its production scheme', () => {
    for (const { key, value } of productionCases) {
      expect(() => {
        assertUrlScheme(key, value, URL_SCHEMES[key], { allowInsecure: false });
      }).not.toThrow();
    }
  });

  it('rejects a wrong scheme per key', () => {
    expect(() => {
      assertUrlScheme('apiBaseUrl', 'http://api.kilo.ai', URL_SCHEMES.apiBaseUrl, {
        allowInsecure: false,
      });
    }).toThrow(/scheme/);
    expect(() => {
      assertUrlScheme(
        'cloudAgentWsUrl',
        'https://cloud-agent.kilo.ai',
        URL_SCHEMES.cloudAgentWsUrl,
        {
          allowInsecure: false,
        }
      );
    }).toThrow(/scheme/);
  });

  it('permits http: and ws: when allowInsecure is true', () => {
    expect(() => {
      assertUrlScheme('apiBaseUrl', 'http://localhost:3000', URL_SCHEMES.apiBaseUrl, {
        allowInsecure: true,
      });
    }).not.toThrow();
    expect(() => {
      assertUrlScheme('cloudAgentWsUrl', 'ws://localhost:8080', URL_SCHEMES.cloudAgentWsUrl, {
        allowInsecure: true,
      });
    }).not.toThrow();
  });

  it('still rejects http: and ws: when allowInsecure is false', () => {
    expect(() => {
      assertUrlScheme('apiBaseUrl', 'http://api.kilo.ai', URL_SCHEMES.apiBaseUrl, {
        allowInsecure: false,
      });
    }).toThrow(/scheme/);
    expect(() => {
      assertUrlScheme('cloudAgentWsUrl', 'ws://cloud-agent.kilo.ai', URL_SCHEMES.cloudAgentWsUrl, {
        allowInsecure: false,
      });
    }).toThrow(/scheme/);
  });

  it('rejects an unparseable URL', () => {
    expect(() => {
      assertUrlScheme('apiBaseUrl', 'not a url', URL_SCHEMES.apiBaseUrl, { allowInsecure: false });
    }).toThrow(/Invalid URL/);
  });

  it('throws a clear error for a missing value', () => {
    expect(() => {
      assertUrlScheme('apiBaseUrl', undefined, URL_SCHEMES.apiBaseUrl, { allowInsecure: false });
    }).toThrow(/Missing URL for apiBaseUrl/);
    expect(() => {
      assertUrlScheme('apiBaseUrl', '', URL_SCHEMES.apiBaseUrl, { allowInsecure: false });
    }).toThrow(/Missing URL for apiBaseUrl/);
  });

  it('eventServiceUrl accepts both https: and wss:', () => {
    expect(() => {
      assertUrlScheme('eventServiceUrl', 'https://events.kilo.ai', URL_SCHEMES.eventServiceUrl, {
        allowInsecure: false,
      });
    }).not.toThrow();
    expect(() => {
      assertUrlScheme('eventServiceUrl', 'wss://events.kilo.ai', URL_SCHEMES.eventServiceUrl, {
        allowInsecure: false,
      });
    }).not.toThrow();
    expect(() => {
      assertUrlScheme('eventServiceUrl', 'http://events.kilo.ai', URL_SCHEMES.eventServiceUrl, {
        allowInsecure: false,
      });
    }).toThrow(/scheme/);
  });
});

describe('assertProductionHost', () => {
  it('accepts a host in the allowlist', () => {
    expect(() => {
      assertProductionHost('apiBaseUrl', 'https://api.kilo.ai', PRODUCTION_HOSTS);
    }).not.toThrow();
    expect(() => {
      assertProductionHost('webBaseUrl', 'https://app.kilo.ai', PRODUCTION_HOSTS);
    }).not.toThrow();
  });

  it('rejects a host outside the allowlist', () => {
    expect(() => {
      assertProductionHost('apiBaseUrl', 'https://evil.example.com', PRODUCTION_HOSTS);
    }).toThrow(/outside the allowlist/);
  });

  it('rejects an unparseable URL', () => {
    expect(() => {
      assertProductionHost('apiBaseUrl', 'not a url', PRODUCTION_HOSTS);
    }).toThrow(/Invalid URL/);
  });

  it('throws a clear error for a missing value', () => {
    expect(() => {
      assertProductionHost('apiBaseUrl', undefined, PRODUCTION_HOSTS);
    }).toThrow(/Missing URL for apiBaseUrl/);
    expect(() => {
      assertProductionHost('apiBaseUrl', '', PRODUCTION_HOSTS);
    }).toThrow(/Missing URL for apiBaseUrl/);
  });
});

// Host-contract guard over the committed production defaults. The required URL
// values live in apps/mobile/.env; the optional latency ingest endpoint is a
// public host committed in code (LATENCY_INGEST_URL_DEFAULT), because a
// committed .env path is credential-shaped to the release gate. Every value
// must pass the scheme check and stay inside the allowlist, so a missing host
// fails the test before any build.
const envPath = fileURLToPath(new URL('../../.env', import.meta.url));
const envSource = readFileSync(envPath, 'utf8');

function parseEnv(source: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const rawLine of source.split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(rawLine.trim());
    const name = match?.[1];
    const value = match?.[2];
    if (name !== undefined && value !== undefined) {
      entries[name] = value;
    }
  }
  return entries;
}

const committedEnv = parseEnv(envSource);
// Every URL key except the optional latency ingest endpoint is a required
// ENV_KEYS entry committed in apps/mobile/.env.
const requiredUrlKeys = (Object.keys(URL_SCHEMES) as (keyof typeof URL_SCHEMES)[]).filter(
  key => key !== 'latencyIngestUrl'
);

describe('committed production URL defaults (host contract)', () => {
  it('accepts every committed .env URL value for scheme and production host', () => {
    for (const key of requiredUrlKeys) {
      const envVar = ENV_KEYS[key as keyof typeof ENV_KEYS];
      const value = committedEnv[envVar];
      expect(value, `${envVar} must be present in the committed .env`).toBeTruthy();
      expect(() => {
        assertUrlScheme(key, value, URL_SCHEMES[key], { allowInsecure: false });
      }).not.toThrow();
      expect(() => {
        assertProductionHost(key, value, PRODUCTION_HOSTS);
      }).not.toThrow();
    }
  });

  it('accepts the committed latency ingest default for scheme and production host', () => {
    expect(() => {
      assertUrlScheme(
        'latencyIngestUrl',
        LATENCY_INGEST_URL_DEFAULT,
        URL_SCHEMES.latencyIngestUrl,
        { allowInsecure: false }
      );
    }).not.toThrow();
    expect(() => {
      assertProductionHost('latencyIngestUrl', LATENCY_INGEST_URL_DEFAULT, PRODUCTION_HOSTS);
    }).not.toThrow();
  });
});

const REQUIRED_ENV: Record<string, string | undefined> = Object.fromEntries(
  Object.values(ENV_KEYS).map(name => [name, committedEnv[name]])
);

const BASE_ENV: Record<string, string | undefined> = {
  ...REQUIRED_ENV,
  EAS_BUILD_PROFILE: undefined,
  SENTRY_AUTH_TOKEN: undefined,
  GOOGLE_PLAY_INTEGRITY_PROJECT_NUMBER: undefined,
  GITHUB_ACTIONS: undefined,
};

function stubBuildEnv(overrides: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries({ ...BASE_ENV, ...overrides })) {
    vi.stubEnv(name, value);
  }
}

function productionEnv(overrides: Record<string, string | undefined>) {
  return {
    EAS_BUILD_PROFILE: 'production',
    SENTRY_AUTH_TOKEN: 'sentry-auth-token',
    [OPTIONAL_ENV_KEYS.playIntegrityProjectNumber]: '123456789012',
    ...overrides,
  };
}

// A static import would evaluate the config once, before any case stubs its
// env; each case needs a fresh evaluation after `vi.resetModules()`.
async function importAppConfig(): Promise<ExpoConfig> {
  vi.resetModules();
  const appConfigModule = await import('../../app.config');
  return appConfigModule.default;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('app.config.ts build gates', () => {
  it('fails a production build that is missing a required URL', async () => {
    stubBuildEnv(productionEnv({ [ENV_KEYS.apiBaseUrl]: undefined }));

    await expect(importAppConfig()).rejects.toThrow(/Missing required environment variables/);
  });

  it('fails a production build with no Sentry auth token', async () => {
    stubBuildEnv(productionEnv({ SENTRY_AUTH_TOKEN: undefined }));

    await expect(importAppConfig()).rejects.toThrow(/SENTRY_AUTH_TOKEN/);
  });

  it('builds a production config from the committed production hosts', async () => {
    stubBuildEnv(productionEnv({}));

    const config = await importAppConfig();

    expect(config.extra?.isProductionBuild).toBe(true);
  });

  it('fails a production build whose URL host is outside the allowlist', async () => {
    stubBuildEnv(productionEnv({ [ENV_KEYS.apiBaseUrl]: 'https://evil.example.com' }));

    await expect(importAppConfig()).rejects.toThrow(/outside the allowlist/);
  });

  it('builds a non-production config that skips a missing URL under CI', async () => {
    vi.spyOn(console, 'warn').mockReturnValue(undefined);
    stubBuildEnv({ GITHUB_ACTIONS: 'true', [ENV_KEYS.notificationsUrl]: undefined });

    const config = await importAppConfig();

    expect(config.extra?.isProductionBuild).toBe(false);
    expect(config.extra?.notificationsUrl).toBeUndefined();
    expect(config.extra?.apiBaseUrl).toBe(committedEnv[ENV_KEYS.apiBaseUrl]);
  });
});

// The build-time URL contract in app.config.ts resolves each URL_SCHEMES key
// through the required and optional maps together, so a URL key's name lives in
// exactly one of them: a URL key that only OPTIONAL_ENV_KEYS names still gets
// its scheme and production-host check. The required-presence check
// (`Object.values(ENV_KEYS)`) stays required-only.
describe('URL key → environment variable resolution', () => {
  it('names every URL key in the required or optional map', () => {
    const urlEnvNames: Record<string, string | undefined> = {
      ...ENV_KEYS,
      ...OPTIONAL_ENV_KEYS,
    };
    for (const key of Object.keys(URL_SCHEMES)) {
      expect(urlEnvNames[key], `${key} must resolve to an env var name`).toBeTruthy();
    }
  });

  it('keeps the optional URL key out of the required-presence values', () => {
    expect(Object.values(ENV_KEYS)).not.toContain('LATENCY_INGEST_URL');
  });
});
