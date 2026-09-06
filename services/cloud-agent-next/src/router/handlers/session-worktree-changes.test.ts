import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccessibleCloudAgentSession } from '@kilocode/worker-utils/cloud-agent-session-access';
import type { WorktreeChangesSnapshot } from '@kilocode/worker-utils/cloud-agent-worktree-changes';
import type { TRPCContext } from '../../types.js';

const { queryAccess } = vi.hoisted(() => ({ queryAccess: vi.fn() }));

vi.mock('@cloudflare/sandbox', () => ({ getSandbox: vi.fn() }));
vi.mock('@kilocode/db/client', () => ({ getWorkerDb: vi.fn(() => ({})) }));
vi.mock('@kilocode/worker-utils/cloud-agent-session-access', () => ({
  queryAccessibleCloudAgentSession: queryAccess,
}));

import { appRouter } from '../../router.js';

const sessionId = 'workspace_12345678-1234-1234-1234-123456789abc';
const legacySessionId = 'agent_12345678-1234-1234-1234-123456789abc';
const access: AccessibleCloudAgentSession = {
  kiloSessionId: 'kilo_root',
  organizationId: 'org_current',
};
const snapshot: WorktreeChangesSnapshot = {
  schemaVersion: 1,
  revision: 1,
  capturedAt: '2026-08-20T10:00:00.000Z',
  comparison: {
    baseRef: 'refs/remotes/origin/main',
    mergeBase: 'a'.repeat(40),
    head: 'b'.repeat(40),
  },
  files: [],
  truncated: false,
};

function setup(userId = 'user_owner') {
  const stub = {
    getWorktreeChanges: vi.fn().mockResolvedValue({ snapshot }),
    refreshWorktreeChanges: vi.fn().mockResolvedValue({ status: 'offline', snapshot }),
  };
  const session = { idFromName: vi.fn(name => name), get: vi.fn(() => stub) };
  const legacy = { idFromName: vi.fn(), get: vi.fn() };
  const control = { getByName: vi.fn() };
  const context = {
    userId,
    authToken: 'test-token',
    request: new Request('https://worker.test/trpc'),
    env: {
      HYPERDRIVE: { connectionString: 'postgresql://test' },
      CONTROL_PLANE_IDS: '',
      SANDBOX_SESSION: session,
      CLOUD_AGENT_SESSION: legacy,
      SANDBOX_CONTROL: control,
    },
  } as unknown as TRPCContext;
  return { stub, session, legacy, control, context, caller: appRouter.createCaller(context) };
}

describe('Worker worktree changes procedures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryAccess.mockResolvedValue(access);
  });

  it.each(['getWorktreeChanges', 'refreshWorktreeChanges'] as const)(
    '%s authorizes existing control sessions without a creation allowlist or runtime work',
    async procedure => {
      const harness = setup();
      const result = await harness.caller[procedure]({ cloudAgentSessionId: sessionId });
      expect(result).toEqual(
        procedure === 'getWorktreeChanges' ? { snapshot } : { status: 'offline', snapshot }
      );
      expect(harness.session.idFromName).toHaveBeenCalledWith(`user_owner:${sessionId}`);
      expect(harness.legacy.get).not.toHaveBeenCalled();
      expect(harness.control.getByName).not.toHaveBeenCalled();
      expect(queryAccess).toHaveBeenCalledWith(expect.anything(), {
        kiloUserId: 'user_owner',
        cloudAgentSessionId: sessionId,
      });
    }
  );

  describe.each(['getWorktreeChanges', 'refreshWorktreeChanges'] as const)(
    '%s access checks',
    procedure => {
      it('rejects an unauthenticated request before access lookup or DO routing', async () => {
        const harness = setup('');
        await expect(
          harness.caller[procedure]({ cloudAgentSessionId: sessionId })
        ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
        expect(queryAccess).not.toHaveBeenCalled();
        expect(harness.session.get).not.toHaveBeenCalled();
      });

      it.each(['another owner', 'revoked organization membership', 'a deleted organization'])(
        'rejects current access denied for %s before any DO call',
        async () => {
          queryAccess.mockResolvedValue(null);
          const harness = setup();
          await expect(
            harness.caller[procedure]({ cloudAgentSessionId: sessionId })
          ).rejects.toMatchObject({ code: 'FORBIDDEN' });
          expect(harness.session.idFromName).not.toHaveBeenCalled();
          expect(harness.session.get).not.toHaveBeenCalled();
          expect(harness.legacy.get).not.toHaveBeenCalled();
          expect(harness.control.getByName).not.toHaveBeenCalled();
        }
      );

      it('fails closed when the authoritative access lookup fails', async () => {
        queryAccess.mockRejectedValueOnce(new Error('database unavailable'));
        const harness = setup();
        await expect(
          harness.caller[procedure]({ cloudAgentSessionId: sessionId })
        ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
        expect(harness.session.get).not.toHaveBeenCalled();
      });

      it('does not route to storage until the current access lookup resolves', async () => {
        const started = Promise.withResolvers<void>();
        const authorized = Promise.withResolvers<AccessibleCloudAgentSession>();
        queryAccess.mockImplementationOnce(async () => {
          started.resolve();
          return authorized.promise;
        });
        const harness = setup();
        const result = harness.caller[procedure]({ cloudAgentSessionId: sessionId });
        await started.promise;
        expect(harness.session.idFromName).not.toHaveBeenCalled();
        expect(harness.session.get).not.toHaveBeenCalled();
        authorized.resolve(access);
        await result;
        expect(harness.session.get).toHaveBeenCalledTimes(1);
      });

      it('rejects legacy sessions after authorization without calling either session DO', async () => {
        const harness = setup();
        await expect(
          harness.caller[procedure]({ cloudAgentSessionId: legacySessionId })
        ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
        expect(queryAccess).toHaveBeenCalledTimes(1);
        expect(harness.session.get).not.toHaveBeenCalled();
        expect(harness.legacy.get).not.toHaveBeenCalled();
        queryAccess.mockResolvedValue(null);
        await expect(
          harness.caller[procedure]({ cloudAgentSessionId: legacySessionId })
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      });

      it('validates the session DO output before exposing cached data', async () => {
        const harness = setup();
        harness.stub[procedure].mockResolvedValue({
          status: 'refreshed',
          snapshot: { ...snapshot, schemaVersion: 2 },
        });
        await expect(
          harness.caller[procedure]({ cloudAgentSessionId: sessionId })
        ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
      });
    }
  );
});
