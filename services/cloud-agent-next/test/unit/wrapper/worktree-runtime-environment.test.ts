import { describe, expect, it } from 'vitest';
import {
  buildWorktreeKiloEnvironment,
  type WorktreeKiloAuth,
} from '../../../wrapper/src/control/worktree-runtime.js';

const identity = {
  sessionId: 'workspace_first',
  kiloSessionId: 'ses_first',
  directory: '/workspace/test-refresh',
};
const auth: WorktreeKiloAuth = {
  scopeId: 'worktree_refresh',
  token: 'real-kilo-original',
  containmentEnabled: false,
  organizationId: 'org-owner',
  targets: {
    backendBaseUrl: 'https://backend.example.test',
    providerBaseUrl: 'https://provider.example.test',
    sessionIngestBaseUrl: 'https://ingest.example.test',
  },
};

describe('cloud runtime feature configuration', () => {
  it('explicitly approves dotenv reads without enabling disabled tools', () => {
    const env = buildWorktreeKiloEnvironment(identity.directory, '/runtime-home', auth, {}, {});

    for (const key of ['KILO_CONFIG_CONTENT', 'OPENCODE_CONFIG_CONTENT']) {
      const config: unknown = JSON.parse(env[key]);
      expect(config).toMatchObject({
        permission: {
          read: { '*': 'allow', '*.env': 'allow', '*.env.*': 'allow' },
          suggest: 'deny',
          schedule_wakeup: 'deny',
          cron_create: 'deny',
        },
      });
    }
  });

  it('disables background subagents, indexing and snapshots despite profile or inherited overrides', () => {
    const overrides = {
      KILO_EXPERIMENTAL_BACKGROUND_SUBAGENTS: 'true',
      KILO_DISABLE_CODEBASE_INDEXING: '',
      KILO_CONFIG_CONTENT: JSON.stringify({ snapshot: true }),
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ snapshot: true }),
    };
    const env = buildWorktreeKiloEnvironment(
      identity.directory,
      '/runtime-home',
      auth,
      overrides,
      overrides
    );
    expect(env.KILO_EXPERIMENTAL_BACKGROUND_SUBAGENTS).toBe('false');
    expect(env.KILO_DISABLE_CODEBASE_INDEXING).toBe('vscode-no-workspace');
    expect(JSON.parse(env.KILO_CONFIG_CONTENT).snapshot).toBe(false);
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT).snapshot).toBe(false);
  });
});
