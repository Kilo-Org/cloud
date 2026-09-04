import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccessibleCloudAgentSession } from '@kilocode/worker-utils/cloud-agent-session-access';
import type {
  GetWorktreeFileOutput,
  WorktreeChangesSnapshot,
} from '@kilocode/worker-utils/cloud-agent-worktree-changes';
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

const fileQuery = { path: 'src/exact\nfile.ts', expectedRevision: 1 };
const savedFile: GetWorktreeFileOutput = {
  status: 'available',
  file: {
    schemaVersion: 1,
    revision: 1,
    path: fileQuery.path,
    diff: {
      status: 'available',
      patch: 'diff --git a/file.ts b/file.ts\nold mode 100644\nnew mode 100755\n',
    },
    content: { status: 'available', source: 'current', text: '' },
  },
  capturedAt: snapshot.capturedAt,
  comparison: snapshot.comparison,
};

function setup(userId = 'user_owner') {
  const stub = {
    getWorktreeChanges: vi.fn().mockResolvedValue({ snapshot }),
    getWorktreeFile: vi.fn().mockResolvedValue(savedFile),
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
  const caller = appRouter.createCaller(context);
  return {
    stub,
    session,
    legacy,
    control,
    context,
    caller,
    call(
      procedure: 'getWorktreeChanges' | 'refreshWorktreeChanges' | 'getWorktreeFile',
      cloudAgentSessionId: string
    ) {
      return procedure === 'getWorktreeFile'
        ? caller.getWorktreeFile({ cloudAgentSessionId, ...fileQuery })
        : caller[procedure]({ cloudAgentSessionId });
    },
  };
}

describe('Worker worktree changes procedures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryAccess.mockResolvedValue(access);
  });

  it.each(['getWorktreeChanges', 'refreshWorktreeChanges', 'getWorktreeFile'] as const)(
    '%s authorizes existing control sessions without a creation allowlist or runtime work',
    async procedure => {
      const harness = setup();
      const result = await harness.call(procedure, sessionId);
      expect(result).toEqual(
        procedure === 'getWorktreeFile'
          ? savedFile
          : procedure === 'getWorktreeChanges'
            ? { snapshot }
            : { status: 'offline', snapshot }
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

  it.each([
    { ...fileQuery, path: '../secret' },
    { ...fileQuery, path: '/secret' },
    { ...fileQuery, expectedRevision: 0 },
    { ...fileQuery, expectedRevision: 1.5 },
    { ...fileQuery, directory: '/workspace/other' },
    { ...fileQuery, baseRef: 'HEAD' },
  ])('rejects invalid selected-file input before accessing storage', async query => {
    const harness = setup();
    await expect(
      harness.caller.getWorktreeFile({ cloudAgentSessionId: sessionId, ...query })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(harness.session.get).not.toHaveBeenCalled();
    expect(queryAccess).not.toHaveBeenCalled();
  });

  it('passes exact paths and revisions without a refresh or runtime request', async () => {
    const harness = setup();
    await expect(
      harness.caller.getWorktreeFile({ cloudAgentSessionId: sessionId, ...fileQuery })
    ).resolves.toEqual(savedFile);
    expect(harness.stub.getWorktreeFile).toHaveBeenCalledWith(fileQuery);
    expect(harness.stub.refreshWorktreeChanges).not.toHaveBeenCalled();
    expect(harness.control.getByName).not.toHaveBeenCalled();
  });

  describe.each(['getWorktreeChanges', 'refreshWorktreeChanges', 'getWorktreeFile'] as const)(
    '%s access checks',
    procedure => {
      it('rejects an unauthenticated request before access lookup or DO routing', async () => {
        const harness = setup('');
        await expect(harness.call(procedure, sessionId)).rejects.toMatchObject({
          code: 'UNAUTHORIZED',
        });
        expect(queryAccess).not.toHaveBeenCalled();
        expect(harness.session.get).not.toHaveBeenCalled();
      });

      it.each(['another owner', 'revoked organization membership', 'a deleted organization'])(
        'rejects current access denied for %s before any DO call',
        async () => {
          queryAccess.mockResolvedValue(null);
          const harness = setup();
          await expect(harness.call(procedure, sessionId)).rejects.toMatchObject({
            code: 'FORBIDDEN',
          });
          expect(harness.session.idFromName).not.toHaveBeenCalled();
          expect(harness.session.get).not.toHaveBeenCalled();
          expect(harness.legacy.get).not.toHaveBeenCalled();
          expect(harness.control.getByName).not.toHaveBeenCalled();
        }
      );

      it('fails closed when the authoritative access lookup fails', async () => {
        queryAccess.mockRejectedValueOnce(new Error('database unavailable'));
        const harness = setup();
        await expect(harness.call(procedure, sessionId)).rejects.toMatchObject({
          code: 'SERVICE_UNAVAILABLE',
        });
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
        const result = harness.call(procedure, sessionId);
        await started.promise;
        expect(harness.session.idFromName).not.toHaveBeenCalled();
        expect(harness.session.get).not.toHaveBeenCalled();
        authorized.resolve(access);
        await result;
        expect(harness.session.get).toHaveBeenCalledTimes(1);
      });

      it('rejects legacy sessions after authorization without calling either session DO', async () => {
        const harness = setup();
        await expect(harness.call(procedure, legacySessionId)).rejects.toMatchObject({
          code: 'PRECONDITION_FAILED',
        });
        expect(queryAccess).toHaveBeenCalledTimes(1);
        expect(harness.session.get).not.toHaveBeenCalled();
        expect(harness.legacy.get).not.toHaveBeenCalled();
        queryAccess.mockResolvedValue(null);
        await expect(harness.call(procedure, legacySessionId)).rejects.toMatchObject({
          code: 'FORBIDDEN',
        });
      });

      it('validates the session DO output before exposing cached data', async () => {
        const harness = setup();
        harness.stub[procedure].mockResolvedValue({
          status: 'refreshed',
          snapshot: { ...snapshot, schemaVersion: 2 },
        });
        await expect(harness.call(procedure, sessionId)).rejects.toMatchObject({
          code: 'INTERNAL_SERVER_ERROR',
        });
      });
    }
  );
});
