import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getSessionSnapshot: vi.fn() }));

vi.mock('../../e2e/client.js', () => ({
  getSessionSnapshot: mocks.getSessionSnapshot,
}));

import type { DriverConfig } from '../../e2e/client.js';
import {
  assertScenarioPreconditions,
  readWorktreeOwnership,
  requireWorktreeSessionIdentity,
} from '../../e2e/public-surface-support.js';

const WORKSPACE_ID = 'workspace_11111111-1111-4111-8111-111111111111';
const KILO_ID = 'ses_aaaaaaaaaaaaBBBBBBBBBBBBBB';

const config: DriverConfig = {
  workerUrl: 'https://worker.example.test',
  user: { id: 'usr_1' },
  skipBalanceCheck: false,
  gitUrl: 'https://example.test/repo.git',
  model: 'kilo/fake-deterministic',
  fakeLlmUrl: 'https://fake.example.test',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('requireWorktreeSessionIdentity', () => {
  it('accepts a workspace uuid and a root ses id', () => {
    expect(() =>
      requireWorktreeSessionIdentity(
        { cloudAgentSessionId: WORKSPACE_ID, kiloSessionId: KILO_ID },
        'chat'
      )
    ).not.toThrow();
  });

  it('rejects a non-workspace session id', () => {
    expect(() =>
      requireWorktreeSessionIdentity(
        {
          cloudAgentSessionId: 'sess_11111111-1111-4111-8111-111111111111',
          kiloSessionId: KILO_ID,
        },
        'chat'
      )
    ).toThrow(/chat did not receive a control-plane workspace_\* identity/);
  });

  it('rejects a malformed kilo session id', () => {
    expect(() =>
      requireWorktreeSessionIdentity(
        { cloudAgentSessionId: WORKSPACE_ID, kiloSessionId: 'ses_short' },
        'chat'
      )
    ).toThrow(/chat did not receive a valid root ses_\* identity/);
  });
});

describe('assertScenarioPreconditions', () => {
  it('accepts the unified API with the deterministic fake model', () => {
    expect(() => assertScenarioPreconditions(config, 'unified')).not.toThrow();
    expect(() => assertScenarioPreconditions(config, undefined)).not.toThrow();
  });

  it('rejects a non-unified API', () => {
    expect(() => assertScenarioPreconditions(config, 'legacy')).toThrow(/require the unified API/);
  });

  it('rejects a non-fake-deterministic model', () => {
    expect(() =>
      assertScenarioPreconditions({ ...config, model: 'kilo/real-model' }, 'unified')
    ).toThrow(/require kilo\/fake-deterministic/);
  });
});

describe('readWorktreeOwnership', () => {
  it('projects the public snapshot into ownership rows', async () => {
    mocks.getSessionSnapshot.mockResolvedValue({
      sessionId: WORKSPACE_ID,
      kiloSessionId: KILO_ID,
      userId: 'usr_1',
      orgId: 'org_1',
      worktreeId: 'worktree_11111111-1111-4111-8111-111111111111',
      parentSessionId: null,
      cloudAgentSessionScopeId: WORKSPACE_ID,
    });

    const rows = await readWorktreeOwnership(config, [WORKSPACE_ID]);

    expect(rows).toEqual([
      {
        sessionId: KILO_ID,
        userId: 'usr_1',
        organizationId: 'org_1',
        parentSessionId: null,
        cloudAgentSessionId: WORKSPACE_ID,
        cloudAgentSessionScopeId: WORKSPACE_ID,
        worktreeId: 'worktree_11111111-1111-4111-8111-111111111111',
      },
    ]);
  });

  it('normalizes absent optional snapshot fields to null', async () => {
    mocks.getSessionSnapshot.mockResolvedValue({
      sessionId: WORKSPACE_ID,
      kiloSessionId: KILO_ID,
      userId: 'usr_1',
    });

    const rows = await readWorktreeOwnership(config, [WORKSPACE_ID]);

    expect(rows[0]).toMatchObject({
      organizationId: null,
      parentSessionId: null,
      cloudAgentSessionScopeId: null,
      worktreeId: null,
    });
  });

  it('throws when the snapshot exposes no kilo session id', async () => {
    mocks.getSessionSnapshot.mockResolvedValue({
      sessionId: WORKSPACE_ID,
      userId: 'usr_1',
    });

    await expect(readWorktreeOwnership(config, [WORKSPACE_ID])).rejects.toThrow(
      /returned no kiloSessionId/
    );
  });
});
