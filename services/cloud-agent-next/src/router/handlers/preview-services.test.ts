import type {
  CloudAgentRootSessionSummary,
  CloudAgentWorkspaceSummary,
} from '@kilocode/session-ingest-contracts';
import type { AccessibleCloudAgentSession } from '@kilocode/worker-utils/cloud-agent-session-access';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreviewTargetResult } from '../../control-plane/sandbox/preview-target.js';
import { parseSessionMetadata, type SessionMetadata } from '../../persistence/session-metadata.js';
import type { TRPCContext } from '../../types.js';

const { queryAccess } = vi.hoisted(() => ({ queryAccess: vi.fn() }));

vi.mock('@kilocode/db/client', () => ({ getWorkerDb: vi.fn(() => ({})) }));
vi.mock('@kilocode/worker-utils/cloud-agent-session-access', () => ({
  queryAccessibleCloudAgentSession: queryAccess,
}));

import { appRouter } from '../../router.js';

const sessionId = 'workspace_12345678-1234-4234-8234-123456789abc';
const worktreeId = 'worktree_22345678-1234-4234-8234-123456789abc';
const kiloSessionId = 'ses_12345678901234567890123456';
const sandboxId = 'ses-12345678901234567890123456';
const userId = 'user_owner';
const orgId = '11111111-1111-4111-8111-111111111111';

const access: AccessibleCloudAgentSession = {
  kiloSessionId: 'kilo_root',
  organizationId: 'org_current',
};

const coordinates: PreviewTargetResult = {
  status: 'ok',
  coordinates: {
    provider: 'cloudflare-containers',
    logicalSandboxId: sandboxId,
    allocationRef: 'allocation-ref',
  },
};

function sessionMetadata(
  input: {
    platform?: string;
    userId?: string;
    orgId?: string;
    sessionId?: string;
    kiloSessionId?: string;
    sandboxId?: string | null;
    worktreeId?: string;
  } = {}
): SessionMetadata {
  return parseSessionMetadata({
    metadataSchemaVersion: 2,
    identity: {
      sessionId: input.sessionId ?? sessionId,
      userId: input.userId ?? userId,
      createdOnPlatform: input.platform ?? 'cloud-agent-web',
      ...(input.orgId === undefined ? {} : { orgId: input.orgId }),
    },
    auth: { kiloSessionId: input.kiloSessionId ?? kiloSessionId },
    agent: { mode: 'code', model: 'test-model' },
    workspace:
      input.sandboxId === null
        ? {
            sandboxProvider: 'cloudflare',
            worktreeId: input.worktreeId ?? worktreeId,
          }
        : {
            sandboxId: input.sandboxId ?? sandboxId,
            sandboxProvider: 'cloudflare-containers',
            worktreeId: input.worktreeId ?? worktreeId,
          },
    lifecycle: { version: 1, timestamp: 1 },
  });
}

function rootSession(
  overrides: Partial<CloudAgentRootSessionSummary> = {}
): CloudAgentRootSessionSummary {
  return {
    kiloSessionId,
    cloudAgentSessionId: sessionId,
    workspaceId: worktreeId,
    userId,
    organizationId: null,
    title: null,
    gitUrl: null,
    gitBranch: null,
    profileId: null,
    createdOnPlatform: 'cloud-agent-web',
    created: 1,
    updated: 1,
    ...overrides,
  };
}

function workspaceSummary(
  overrides: Partial<CloudAgentWorkspaceSummary> = {}
): CloudAgentWorkspaceSummary {
  return {
    workspaceId: worktreeId,
    userId,
    organizationId: null,
    name: null,
    repositoryProvider: 'github',
    gitUrl: 'https://github.com/Kilo-Org/cloud',
    gitBranch: 'main',
    profileId: null,
    deletionState: 'active',
    created: 1,
    updated: 1,
    lastActivity: 1,
    sessions: [rootSession()],
    nextSessionCursor: null,
    ...overrides,
  };
}

function setup(
  options: {
    user?: string;
    organizationId?: string | null;
    workspace?: CloudAgentWorkspaceSummary | null;
    metadata?: SessionMetadata | null;
    previewTarget?: PreviewTargetResult;
  } = {}
) {
  const contextUserId = options.user ?? userId;
  const organizationId = options.organizationId ?? null;
  const getCloudAgentWorkspace = vi.fn(async () =>
    options.workspace === undefined
      ? workspaceSummary({
          organizationId,
          sessions: [rootSession({ organizationId })],
        })
      : options.workspace
  );
  const getMetadata = vi.fn(async () =>
    options.metadata === undefined
      ? sessionMetadata({ ...(organizationId === null ? {} : { orgId: organizationId }) })
      : options.metadata
  );
  const previewTarget = vi.fn(async () => options.previewTarget ?? coordinates);
  const previewServices = vi.fn().mockResolvedValue({
    services: [{ port: 3001, name: 'Next.js' }],
    status: 'running',
  });
  const listPreviewServices = vi.fn().mockResolvedValue({
    services: [{ port: 3001, name: 'Next.js' }],
    status: 'running',
  });
  const sessionStub = { getMetadata, listPreviewServices };
  const session = { idFromName: vi.fn(name => name), get: vi.fn(() => sessionStub) };
  const sandbox = { getByName: vi.fn(() => ({ previewTarget, previewServices })) };
  const context = {
    userId: contextUserId,
    authToken: 'test-token',
    request: new Request('https://worker.test/trpc'),
    env: {
      HYPERDRIVE: { connectionString: 'postgresql://test' },
      SESSION_INGEST: { getCloudAgentWorkspace },
      SANDBOX_SESSION: session,
      SANDBOX_CONTROL: sandbox,
    },
  } as unknown as TRPCContext;
  return {
    caller: appRouter.createCaller(context),
    sessionStub,
    session,
    sandbox,
    getCloudAgentWorkspace,
    getMetadata,
    previewTarget,
    previewServices,
  };
}

describe('listPreviewServices', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryAccess.mockResolvedValue(access);
  });

  describe('session target', () => {
    it('authorizes the current session and returns discovered services', async () => {
      const { caller, sessionStub } = setup();

      await expect(caller.listPreviewServices({ cloudAgentSessionId: sessionId })).resolves.toEqual(
        {
          services: [{ port: 3001, name: 'Next.js' }],
          status: 'running',
        }
      );
      expect(queryAccess).toHaveBeenCalledWith(expect.anything(), {
        kiloUserId: userId,
        cloudAgentSessionId: sessionId,
      });
      expect(sessionStub.listPreviewServices).toHaveBeenCalledTimes(1);
    });

    it('passes a known availability status through without inventing services', async () => {
      const { caller, sessionStub } = setup();
      sessionStub.listPreviewServices.mockResolvedValue({ services: [], status: 'not_running' });

      await expect(caller.listPreviewServices({ cloudAgentSessionId: sessionId })).resolves.toEqual(
        {
          services: [],
          status: 'not_running',
        }
      );
    });

    it('rejects a caller without current session access before touching the sandbox', async () => {
      const { caller, sessionStub } = setup({ user: 'user_other' });
      queryAccess.mockResolvedValue(null);

      await expect(
        caller.listPreviewServices({ cloudAgentSessionId: sessionId })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(sessionStub.listPreviewServices).not.toHaveBeenCalled();
    });

    it('surfaces a discovery failure instead of returning an empty list', async () => {
      const { caller, sessionStub } = setup();
      sessionStub.listPreviewServices.mockRejectedValue(new Error('scan transport failed'));

      await expect(caller.listPreviewServices({ cloudAgentSessionId: sessionId })).rejects.toThrow(
        'scan transport failed'
      );
    });

    it('rejects non-workspace session ids at the input boundary', async () => {
      const { caller, sessionStub } = setup();

      await expect(
        caller.listPreviewServices({
          cloudAgentSessionId: 'agent_12345678-1234-4234-8234-123456789abc',
        } as never)
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(sessionStub.listPreviewServices).not.toHaveBeenCalled();
    });
  });

  describe('worktree target', () => {
    it('resolves the workspace root sandbox and discovers its services', async () => {
      const { caller, sandbox, getCloudAgentWorkspace, previewTarget, previewServices } = setup();

      await expect(caller.listPreviewServices({ worktreeId })).resolves.toEqual({
        services: [{ port: 3001, name: 'Next.js' }],
        status: 'running',
      });
      expect(queryAccess).not.toHaveBeenCalled();
      expect(getCloudAgentWorkspace).toHaveBeenCalledWith({
        kiloUserId: userId,
        workspaceId: worktreeId,
        sessionLimit: 1,
      });
      expect(sandbox.getByName).toHaveBeenCalledWith(sandboxId);
      expect(previewTarget).toHaveBeenCalledWith({
        ownerId: userId,
        organizationId: null,
        scopeId: worktreeId,
      });
      expect(previewServices).toHaveBeenCalledWith({
        ownerId: userId,
        organizationId: null,
        scopeId: worktreeId,
      });
    });

    it('passes the organization from the input through to the workspace scope', async () => {
      const { caller, previewTarget, previewServices } = setup({ organizationId: orgId });

      await expect(
        caller.listPreviewServices({ worktreeId, organizationId: orgId })
      ).resolves.toEqual({
        services: [{ port: 3001, name: 'Next.js' }],
        status: 'running',
      });
      expect(previewTarget).toHaveBeenCalledWith({
        ownerId: userId,
        organizationId: orgId,
        scopeId: worktreeId,
      });
      expect(previewServices).toHaveBeenCalledWith({
        ownerId: userId,
        organizationId: orgId,
        scopeId: worktreeId,
      });
    });

    it('denies a worktree the caller does not own before touching the sandbox', async () => {
      const { caller, getMetadata, previewTarget, previewServices } = setup({
        workspace: workspaceSummary({ userId: 'user_other' }),
      });

      await expect(caller.listPreviewServices({ worktreeId })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(getMetadata).not.toHaveBeenCalled();
      expect(previewTarget).not.toHaveBeenCalled();
      expect(previewServices).not.toHaveBeenCalled();
    });

    it('reports a stopped sandbox without asking it to scan', async () => {
      const { caller, previewServices } = setup({ previewTarget: { status: 'not_running' } });

      await expect(caller.listPreviewServices({ worktreeId })).resolves.toEqual({
        services: [],
        status: 'not_running',
      });
      expect(previewServices).not.toHaveBeenCalled();
    });

    it('reports a sandbox that is still preparing without asking it to scan', async () => {
      const { caller, previewServices } = setup({ previewTarget: { status: 'not_ready' } });

      await expect(caller.listPreviewServices({ worktreeId })).resolves.toEqual({
        services: [],
        status: 'not_ready',
      });
      expect(previewServices).not.toHaveBeenCalled();
    });

    it('rejects a malformed worktree id at the input boundary', async () => {
      const { caller, previewTarget } = setup();

      await expect(
        caller.listPreviewServices({ worktreeId: 'worktree_nope' } as never)
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(previewTarget).not.toHaveBeenCalled();
    });

    it('rejects a target naming both a worktree and a session', async () => {
      const { caller, previewTarget } = setup();

      await expect(
        caller.listPreviewServices({ worktreeId, cloudAgentSessionId: sessionId } as never)
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(previewTarget).not.toHaveBeenCalled();
    });
  });
});
