import { describe, expect, it } from 'vitest';
import { assertAvailableProvider, getProviderAdapter, resolveDefaultProvider } from './index';

describe('provider registry', () => {
  it('resolves docker-local from the default provider env var', () => {
    expect(resolveDefaultProvider({ KILOCLAW_DEFAULT_PROVIDER: 'docker-local' })).toBe(
      'docker-local'
    );
  });

  it('falls back to fly for invalid default-provider values', () => {
    expect(resolveDefaultProvider({ KILOCLAW_DEFAULT_PROVIDER: 'bogus' })).toBe('fly');
  });

  it('allows docker-local in development', () => {
    expect(() =>
      assertAvailableProvider({ WORKER_ENV: 'development' } as never, 'docker-local')
    ).not.toThrow();
  });

  it('rejects docker-local outside development', () => {
    expect(() =>
      assertAvailableProvider({ WORKER_ENV: 'production' } as never, 'docker-local')
    ).toThrow('Provider docker-local is only available in development');
  });

  it('returns the docker-local adapter in development', () => {
    const adapter = getProviderAdapter(
      { WORKER_ENV: 'development', DOCKER_LOCAL_API_BASE: 'http://127.0.0.1:23750' } as never,
      { provider: 'docker-local' }
    );

    expect(adapter.id).toBe('docker-local');
  });
});
