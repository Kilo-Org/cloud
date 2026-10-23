import { describe, expect, it, vi } from 'vitest';
import type { CanDestroyCloudAgentWorktreeSandboxResult } from '@kilocode/session-ingest-contracts';
import type { Env } from '../types';
import { reconcileSandboxReferences } from './worktree-ownership';

const kiloUserId = 'user_1';
const controlSessionId = 'workspace_11111111-1111-4111-8111-111111111111';

function envFor(verdict: CanDestroyCloudAgentWorktreeSandboxResult) {
  const idFromName = vi.fn((name: string) => name);
  const env = {
    SESSION_INGEST: { canDestroyCloudAgentWorktreeSandbox: vi.fn(async () => verdict) },
    SANDBOX_SESSION: { idFromName, get: vi.fn(() => ({ getMetadata: async () => null })) },
  } as unknown as Env;
  return { env, idFromName };
}

describe('reconcileSandboxReferences', () => {
  it('skips retired agent sessions when it looks up owner runtimes', async () => {
    const { env, idFromName } = envFor({
      kind: 'unresolved',
      owners: [
        {
          worktreeId: 'worktree_22222222-2222-4222-8222-222222222222',
          organizationId: null,
          allocationLocation: { sandboxId: 'other-sandbox', provider: 'cloudflare' },
          sessions: [
            { sessionId: null, cloudAgentSessionId: 'agent_33333333-3333-4333-8333-333333333333' },
            { sessionId: null, cloudAgentSessionId: controlSessionId },
          ],
        },
      ],
    });

    await expect(
      reconcileSandboxReferences(env, {
        worktreeId: 'worktree_44444444-4444-4444-8444-444444444444',
        kiloUserId,
        location: { sandboxId: 'target-sandbox', provider: 'cloudflare' },
      })
    ).resolves.toEqual({ complete: true, foreign: false, unavailable: false });
    expect(idFromName.mock.calls).toEqual([[`${kiloUserId}:${controlSessionId}`]]);
  });
});
