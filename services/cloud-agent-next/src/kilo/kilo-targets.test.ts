import { describe, expect, it } from 'vitest';
import {
  backendUrlForSandbox,
  deriveKiloSandboxTargets,
  providerBaseUrlEncodedInToken,
} from './kilo-targets.js';

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
});
