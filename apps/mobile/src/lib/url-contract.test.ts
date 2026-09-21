// eslint-disable-next-line import/no-nodejs-modules -- vitest-only guard, runs in node, never bundled into the app
import { readFileSync } from 'node:fs';
// eslint-disable-next-line import/no-nodejs-modules -- vitest-only guard, runs in node, never bundled into the app
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  assertProductionHost,
  assertUrlScheme,
  LATENCY_INGEST_URL_DEFAULT,
  PRODUCTION_HOSTS,
  URL_SCHEMES,
} from '@/lib/url-contract';
import { ENV_KEYS } from './env-keys';

describe('assertUrlScheme', () => {
  const productionCases: { key: keyof typeof URL_SCHEMES; value: string }[] = [
    { key: 'apiBaseUrl', value: 'https://api.kilo.ai' },
    { key: 'webBaseUrl', value: 'https://app.kilo.ai' },
    { key: 'kiloChatUrl', value: 'https://chat.kilo.ai' },
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

// Text-contract guard over app.config.ts. The URL-contract loop must skip
// absent values (warn-under-CI path), and the production path must keep its
// fatal-by-intent throw and Sentry source-map gate.
const configPath = fileURLToPath(new URL('../../app.config.ts', import.meta.url));
const configSource = readFileSync(configPath, 'utf8');
const configTsPath = fileURLToPath(new URL('config.ts', import.meta.url));
const configTsSource = readFileSync(configTsPath, 'utf8');

// Removes `//` line comments and `/* */` block comments while preserving line
// breaks, so a comment mentioning a gate cannot satisfy the assertion.
function stripComments(source: string): string {
  return source
    .replaceAll(/\/\*[\s\S]*?\*\//g, match => match.replaceAll(/[^\n]/g, ''))
    .replaceAll(/\/\/[^\n]*/g, '');
}

const configCodeSource = stripComments(configSource);
const configTsCodeSource = stripComments(configTsSource);

describe('app.config.ts config boundary (text contract)', () => {
  it('skips absent URL values instead of asserting them', () => {
    expect(configCodeSource).toMatch(/if \(!value\)\s*continue/);
  });

  it('keeps the fatal-by-intent production gate', () => {
    expect(configCodeSource).toMatch(/EAS_BUILD_PROFILE === 'production'/);
  });

  it('keeps the Sentry source-map upload gate', () => {
    expect(configCodeSource).toMatch(/SENTRY_AUTH_TOKEN/);
  });

  it('bakes isProductionBuild into the extra block', () => {
    expect(configCodeSource).toMatch(/extra:\s*\{[\s\S]*?isProductionBuild,/);
  });

  it('gates the runtime production host check on the baked flag', () => {
    expect(configTsCodeSource).toContain('extra?.isProductionBuild === true');
  });
});

// The build-time loop resolves each URL_SCHEMES key through ENV_KEYS
// (`process.env[ENV_KEYS[key]]`), so the optional latency ingest URL has to
// resolve there too: otherwise its scheme and production-host check is
// silently skipped and a bad override throws at launch in config.ts instead.
// env-keys.js defines that entry non-enumerably, so the lookup finds the name
// while the required-presence check (`Object.values(ENV_KEYS)`) stays
// required-only.
describe('URL key → environment variable resolution', () => {
  it('resolves every URL key through ENV_KEYS, optional keys included', () => {
    for (const key of Object.keys(URL_SCHEMES)) {
      const envVar = ENV_KEYS[key as keyof typeof ENV_KEYS];
      expect(envVar, `${key} must resolve to an env var name`).toBeTruthy();
    }
  });

  it('keeps the optional URL key out of the required-presence values', () => {
    expect(Object.values(ENV_KEYS)).not.toContain('LATENCY_INGEST_URL');
  });

  it('keeps app.config.ts resolving URL values through ENV_KEYS', () => {
    expect(configCodeSource).toMatch(/process\.env\[ENV_KEYS\[/);
  });
});
