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
  it('inherits only platform settings and keeps explicit workspace variables', () => {
    const env = buildWorktreeKiloEnvironment(
      '/workspace/a',
      '/home/worktree-a',
      kilo(),
      { CUSTOM_SETTING: 'workspace-value', GH_TOKEN: 'workspace-git-alias' },
      {
        PATH: '/usr/bin:/bin',
        LANG: 'C.UTF-8',
        NODE_EXTRA_CA_CERTS: '/etc/ssl/certs/intercept.pem',
        REQUESTS_CA_BUNDLE: '/etc/ssl/certs/ca-certificates.crt',
        SANDBOX_TRANSFER_GRANT: 'synthetic-transfer-grant',
        SANDBOX_CONTROL_CREDENTIAL: 'synthetic-control-credential',
        CONTROL_LOG_UPLOAD_GRANT: 'synthetic-log-grant',
        FUTURE_CONTROL_SECRET: 'synthetic-future-secret',
        GH_TOKEN: 'wrapper-git-secret',
        LD_PRELOAD: '/wrapper-only.so',
        BASH_ENV: '/wrapper-only.sh',
        CUSTOM_SETTING: 'inherited-value',
      }
    );

    expect(env.PATH).toBe('/usr/bin:/bin');
    expect(env.LANG).toBe('C.UTF-8');
    expect(env.NODE_EXTRA_CA_CERTS).toBe('/etc/ssl/certs/intercept.pem');
    expect(env.REQUESTS_CA_BUNDLE).toBe('/etc/ssl/certs/ca-certificates.crt');
    expect(env.CUSTOM_SETTING).toBe('workspace-value');
    expect(env.GH_TOKEN).toBe('workspace-git-alias');
    expect(env.USER).toBe('kilo');
    expect(env.LOGNAME).toBe('kilo');
    for (const key of [
      'SANDBOX_TRANSFER_GRANT',
      'SANDBOX_CONTROL_CREDENTIAL',
      'CONTROL_LOG_UPLOAD_GRANT',
      'FUTURE_CONTROL_SECRET',
      'LD_PRELOAD',
      'BASH_ENV',
    ]) {
      expect(env[key]).toBeUndefined();
    }
  });

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
