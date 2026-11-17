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
  it.each([undefined, 'stream', 'relay'] as const)(
    'projects only read-mode kind for chat %s',
    transport => {
      const env = buildWorktreeKiloEnvironment(
        '/workspace/a',
        '/home/worktree-a',
        kilo(),
        {},
        {},
        undefined,
        transport ? { chat: { transport } } : undefined
      );
      if (transport === 'relay') expect(env.KILO_REMOTE_KIND).toBe('remote');
      else expect(env.KILO_REMOTE_KIND).toBeUndefined();
      expect(env.KILO_REMOTE).toBeUndefined();
      const config = env.KILO_CONFIG_CONTENT;
      if (config === undefined)
        throw new Error('The wrapper did not produce runtime configuration');
      expect(JSON.parse(config).remote_control).toBeUndefined();
    }
  );
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
