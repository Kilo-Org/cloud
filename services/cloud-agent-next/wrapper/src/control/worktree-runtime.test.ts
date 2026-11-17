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
