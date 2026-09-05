import { describe, expect, it } from 'vitest';
import {
  backendUrlForSandbox,
  deriveKiloSandboxTargets,
  providerBaseUrlEncodedInToken,
} from './kilo-targets.js';
import {
  historicalCliRoute,
  historicalRouteFixtures,
} from './__fixtures__/runtime-url-normalization.js';

describe('immutable historical Kilo route normalization', () => {
  it.each([
    ['origin facade', 'https://worker.example.test'],
    ['safe prefixed facade', 'https://worker.example.test/runtime-proxy'],
  ])('%s keeps v7.4.20 and current requests inside the Worker facade', (_name, facade) => {
    for (const fixture of historicalRouteFixtures) {
      const routed = new URL(historicalCliRoute(facade, fixture.path));
      expect(routed.origin).toBe('https://worker.example.test');
      expect(routed.pathname).toBe(
        `${new URL(facade).pathname.replace(/\/+$/, '')}${fixture.path}`
      );
      if (new URL(facade).pathname !== '/') expect(routed.pathname).not.toBe(fixture.path);
    }
  });
});

describe('providerBaseUrlEncodedInToken', () => {
  it('extracts and normalizes a provider base while preserving the full token separately', () => {
    expect(
      providerBaseUrlEncodedInToken('http://localhost:9911/api/openrouter/:provider-token')
    ).toBe('http://localhost:9911/api/openrouter');
  });

  it.each([undefined, '', 'ordinary-token', 'ftp://localhost/path:token', 'not a url:token'])(
    'does not infer a target from %s',
    token => {
      expect(providerBaseUrlEncodedInToken(token)).toBeUndefined();
    }
  );
});

describe('backendUrlForSandbox', () => {
  it.each([
    ['http://localhost:3000/api/', 'http://host.docker.internal:3000/api'],
    ['http://127.0.0.1:8800/', 'http://host.docker.internal:8800'],
    ['https://api.kilo.ai/base/', 'https://api.kilo.ai/base'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(backendUrlForSandbox(input)).toBe(expected);
  });
});

describe('deriveKiloSandboxTargets', () => {
  it('uses the approved defaults', () => {
    expect(deriveKiloSandboxTargets({}, 'user-token')).toEqual({
      success: true,
      targets: {
        backendBaseUrl: 'https://api.kilo.ai',
        providerBaseUrl: 'https://api.kilo.ai',
        sessionIngestBaseUrl: 'https://ingest.kilosessions.ai',
      },
    });
  });

  it('applies token URL, configured provider, then backend precedence', () => {
    expect(
      deriveKiloSandboxTargets(
        {
          KILOCODE_BACKEND_BASE_URL: 'https://backend.example.com/base',
          KILO_OPENROUTER_BASE: 'https://configured.example.com/api',
        },
        'http://localhost:9911/api/openrouter:raw-provider-token'
      )
    ).toEqual({
      success: true,
      targets: {
        backendBaseUrl: 'https://backend.example.com/base',
        providerBaseUrl: 'http://host.docker.internal:9911/api/openrouter',
        sessionIngestBaseUrl: 'https://ingest.kilosessions.ai',
      },
    });

    expect(
      deriveKiloSandboxTargets(
        {
          KILOCODE_BACKEND_BASE_URL: 'https://backend.example.com/base',
          KILO_OPENROUTER_BASE: 'https://configured.example.com/api',
        },
        'raw-user-token'
      )
    ).toMatchObject({
      success: true,
      targets: { providerBaseUrl: 'https://configured.example.com/api' },
    });
  });

  it('rewrites explicit localhost backend and ingest targets for the sandbox', () => {
    expect(
      deriveKiloSandboxTargets(
        {
          KILOCODE_BACKEND_BASE_URL: 'http://localhost:3000/root/',
          KILO_SESSION_INGEST_URL: 'http://127.0.0.1:8800/ingest/',
        },
        'user-token'
      )
    ).toMatchObject({
      success: true,
      targets: {
        backendBaseUrl: 'http://host.docker.internal:3000/root',
        providerBaseUrl: 'http://host.docker.internal:3000/root',
        sessionIngestBaseUrl: 'http://host.docker.internal:8800/ingest',
      },
    });
  });

  it.each([
    ['production HTTP', { KILOCODE_BACKEND_BASE_URL: 'http://api.kilo.ai' }],
    ['userinfo', { KILO_OPENROUTER_BASE: 'https://user@example.com/api' }],
    ['query', { KILO_SESSION_INGEST_URL: 'https://ingest.example.com/root?target=other' }],
    ['encoded separator', { KILOCODE_BACKEND_BASE_URL: 'https://api.example.com/base%2fescape' }],
  ] as const)('rejects %s targets', (_description, env) => {
    expect(deriveKiloSandboxTargets(env, 'user-token')).toEqual({
      success: false,
      reason: 'invalid_target',
    });
  });

  it('preserves HTTPS target base paths, ports, and token-selected provider precedence', () => {
    expect(
      deriveKiloSandboxTargets(
        {
          KILOCODE_BACKEND_BASE_URL: 'https://backend.example.com:8443/tenant/api/',
          KILO_OPENROUTER_BASE: 'https://configured.example.com/ignored',
          KILO_SESSION_INGEST_URL: 'https://ingest.example.com:9443/events/',
        },
        'https://provider.example.com:7443/custom/api/openrouter/:real-provider-token',
        { requireHttps: true }
      )
    ).toEqual({
      success: true,
      targets: {
        backendBaseUrl: 'https://backend.example.com:8443/tenant/api',
        providerBaseUrl: 'https://provider.example.com:7443/custom/api/openrouter',
        sessionIngestBaseUrl: 'https://ingest.example.com:9443/events',
      },
    });
  });

  it.each([
    ['production HTTP', 'http://api.example.com/base'],
    ['local HTTP', 'http://localhost:3000/base'],
    ['HTTPS localhost', 'https://localhost/base'],
    ['localhost DNS suffix', 'https://service.localhost/base'],
    ['Docker host', 'https://host.docker.internal/base'],
    ['IPv4 address', 'https://127.0.0.1/base'],
    ['alternative IPv4 address', 'https://2130706433/base'],
    ['IPv6 address', 'https://[::1]/base'],
    ['single-label hostname', 'https://internal/base'],
    ['invalid DNS hostname', 'https://bad_host.example.com/base'],
    ['invalid DNS label', 'https://-bad.example.com/base'],
    ['userinfo', 'https://user:password@example.com/base'],
    ['query string', 'https://api.example.com/base?target=other'],
    ['empty query string', 'https://api.example.com/base?'],
    ['fragment', 'https://api.example.com/base#other'],
    ['malformed URL', 'https://api.example.com:99999/base'],
    ['malformed percent encoding', 'https://api.example.com/base/%GG'],
    ['malformed UTF-8 percent encoding', 'https://api.example.com/base/%E0%A4%A'],
    ['raw parent traversal', 'https://api.example.com/base/../escape'],
    ['raw current-directory traversal', 'https://api.example.com/base/./escape'],
    ['encoded parent traversal', 'https://api.example.com/base/%2e%2e/escape'],
    ['mixed encoded parent traversal', 'https://api.example.com/base/.%2e/escape'],
    ['double-encoded parent traversal', 'https://api.example.com/base/%252e%252e/escape'],
    ['encoded slash', 'https://api.example.com/base%2fescape'],
    ['encoded backslash', 'https://api.example.com/base%5cescape'],
    ['double-encoded slash', 'https://api.example.com/base%252fescape'],
    ['triple-encoded backslash', 'https://api.example.com/base%25255cescape'],
    ['raw backslash', 'https://api.example.com/base\\escape'],
    ['duplicate path boundary', 'https://api.example.com/base//escape'],
    ['encoded control character', 'https://api.example.com/base%00escape'],
    ['leading whitespace', ' https://api.example.com/base'],
  ] as const)('rejects %s before normalizing any contained target', (_description, target) => {
    for (const key of [
      'KILOCODE_BACKEND_BASE_URL',
      'KILO_OPENROUTER_BASE',
      'KILO_SESSION_INGEST_URL',
    ] as const) {
      expect(
        deriveKiloSandboxTargets({ [key]: target }, 'user-token', { requireHttps: true })
      ).toEqual({
        success: false,
        reason: 'invalid_target',
      });
    }
  });

  it.each([
    'http://localhost:9911/api/openrouter:real-token',
    'https://provider.example.com/api/openrouter/../session:real-token',
    'https://provider.example.com/api/openrouter/%252e%252e/session:real-token',
    'https://provider.example.com/api/openrouter%252fescape:real-token',
    'https://provider.example.com/api/openrouter/%GG:real-token',
  ])('rejects unsafe token-encoded provider targets before URL normalization: %s', token => {
    expect(
      deriveKiloSandboxTargets(
        { KILO_OPENROUTER_BASE: 'https://safe-provider.example.com/api/openrouter' },
        token,
        { requireHttps: true }
      )
    ).toEqual({ success: false, reason: 'invalid_target' });
  });

  it('preserves legacy local Cloudflare target behavior unless HTTPS is explicitly required', () => {
    const env = {
      KILOCODE_BACKEND_BASE_URL: 'http://localhost:3000/root/',
      KILO_SESSION_INGEST_URL: 'http://127.0.0.1:8800/ingest/',
    };

    expect(deriveKiloSandboxTargets(env, 'user-token')).toMatchObject({
      success: true,
      targets: {
        backendBaseUrl: 'http://host.docker.internal:3000/root',
        providerBaseUrl: 'http://host.docker.internal:3000/root',
        sessionIngestBaseUrl: 'http://host.docker.internal:8800/ingest',
      },
    });
    expect(deriveKiloSandboxTargets(env, 'user-token', { requireHttps: false })).toMatchObject({
      success: true,
    });
    expect(deriveKiloSandboxTargets(env, 'user-token', { requireHttps: true })).toEqual({
      success: false,
      reason: 'invalid_target',
    });
  });
});
