import { describe, expect, it } from 'bun:test';

import { buildWorktreeKiloEnvironment } from './worktree-runtime.js';

function kilo() {
  return {
    scopeId: 'notifier-test',
    token: 'opaque-token',
    targets: {
      backendBaseUrl: 'https://backend.example.test',
      providerBaseUrl: 'https://provider.example.test',
      sessionIngestBaseUrl: 'https://ingest.example.test',
    },
  };
}

describe('buildWorktreeKiloEnvironment notifier env', () => {
  it('forces both gh update notifiers off after profile environment', () => {
    const env = buildWorktreeKiloEnvironment(
      '/workspace/a',
      '/home/worktree-a',
      kilo(),
      {
        GH_NO_EXTENSION_UPDATE_NOTIFIER: '0',
        GH_STACK_NO_UPDATE_NOTIFIER: '0',
      },
      {}
    );

    expect(env.GH_NO_EXTENSION_UPDATE_NOTIFIER).toBe('1');
    expect(env.GH_STACK_NO_UPDATE_NOTIFIER).toBe('1');
  });

  it('forces the notifiers off even when the inherited environment sets them', () => {
    const env = buildWorktreeKiloEnvironment(
      '/workspace/a',
      '/home/worktree-a',
      kilo(),
      {},
      { GH_NO_EXTENSION_UPDATE_NOTIFIER: '0', GH_STACK_NO_UPDATE_NOTIFIER: '0' }
    );

    expect(env.GH_NO_EXTENSION_UPDATE_NOTIFIER).toBe('1');
    expect(env.GH_STACK_NO_UPDATE_NOTIFIER).toBe('1');
  });
});

describe('buildWorktreeKiloEnvironment model context limits', () => {
  function configOf(env: Record<string, string>) {
    return JSON.parse(env.KILO_CONFIG_CONTENT);
  }

  it('writes personal context caps as provider model limit entries', () => {
    const env = buildWorktreeKiloEnvironment(
      '/workspace/a',
      '/home/worktree-a',
      kilo(),
      {},
      {},
      undefined,
      { modelContextLimits: { 'openai/gpt-6.1-sol': 300_000, 'kilo/openai/gpt-6-sol': 250_000 } }
    );

    expect(configOf(env).provider.kilo.models).toEqual({
      'openai/gpt-6.1-sol': { limit: { context: 300_000 } },
      'openai/gpt-6-sol': { limit: { context: 250_000 } },
    });
  });

  it('omits the models block when no caps are configured', () => {
    const withoutLimits = buildWorktreeKiloEnvironment(
      '/workspace/a',
      '/home/worktree-a',
      kilo(),
      {},
      {}
    );
    const withEmptyLimits = buildWorktreeKiloEnvironment(
      '/workspace/a',
      '/home/worktree-a',
      kilo(),
      {},
      {},
      undefined,
      { modelContextLimits: {} }
    );

    expect(configOf(withoutLimits).provider.kilo.models).toBeUndefined();
    expect(configOf(withEmptyLimits).provider.kilo.models).toBeUndefined();
  });
});
