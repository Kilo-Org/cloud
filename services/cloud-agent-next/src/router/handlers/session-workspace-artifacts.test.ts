import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccessibleCloudAgentSession } from '@kilocode/worker-utils/cloud-agent-session-access';
import type {
  ListWorkspaceArtifactsOutput,
  WorkspaceArtifactEntry,
} from '@kilocode/worker-utils/cloud-agent-workspace-artifacts';
import type { SessionMetadata } from '../../persistence/session-metadata.js';
import type { TRPCContext } from '../../types.js';

const { queryAccess, createR2Client, getSignedURL } = vi.hoisted(() => ({
  queryAccess: vi.fn(),
  createR2Client: vi.fn(),
  getSignedURL: vi.fn(),
}));

vi.mock('@kilocode/db/client', () => ({ getWorkerDb: vi.fn(() => ({})) }));
vi.mock('@kilocode/worker-utils/cloud-agent-session-access', () => ({
  queryAccessibleCloudAgentSession: queryAccess,
}));
vi.mock('@kilocode/worker-utils/r2-client', () => ({ createR2Client }));

import { appRouter } from '../../router.js';

const sessionId = 'workspace_12345678-1234-1234-1234-123456789abc';
const legacySessionId = 'agent_12345678-1234-1234-1234-123456789abc';
const sandboxId = 'ses-0123456789abcdef';
const access: AccessibleCloudAgentSession = {
  kiloSessionId: 'kilo_root',
  organizationId: 'org_current',
};
const entry: WorkspaceArtifactEntry = {
  relativePath: 'reports/weekly.pdf',
  contentHash: 'a'.repeat(64),
  sizeBytes: 1_024,
  contentType: 'application/pdf',
  updatedAt: 1_760_000_000_000,
  expiresAt: 1_760_000_000_000 + 14 * 24 * 60 * 60 * 1_000,
};
const list: ListWorkspaceArtifactsOutput = { revision: 3, entries: [entry] };
const metadata = {
  identity: { sessionId, userId: 'user_owner', orgId: 'org_current' },
  workspace: { sandboxId },
} as unknown as SessionMetadata;

function setup(
  options: {
    userId?: string;
    metadata?: SessionMetadata | null;
    env?: Record<string, unknown>;
  } = {}
) {
  const sessionStub = { getMetadata: vi.fn().mockResolvedValue(metadata) };
  const session = { idFromName: vi.fn(name => name), get: vi.fn(() => sessionStub) };
  const controlStub = {
    listWorkspaceArtifacts: vi.fn().mockResolvedValue(list),
    getWorkspaceArtifact: vi.fn().mockResolvedValue({
      objectKey: `${sandboxId}/object`,
      entry,
    }),
    deleteWorkspaceArtifactForUser: vi.fn().mockResolvedValue({ status: 'deleted', revision: 4 }),
  };
  const control = { getByName: vi.fn(() => controlStub) };

  if (options.metadata !== undefined) {
    sessionStub.getMetadata.mockResolvedValue(options.metadata);
  }
  createR2Client.mockReturnValue({ getSignedURL });
  getSignedURL.mockResolvedValue('https://account.r2.cloudflarestorage.com/signed');

  const context = {
    userId: options.userId ?? 'user_owner',
    authToken: 'test-token',
    request: new Request('https://worker.test/trpc'),
    env: {
      HYPERDRIVE: { connectionString: 'postgresql://test' },
      SANDBOX_SESSION: session,
      SANDBOX_CONTROL: control,
      R2_ENDPOINT: 'https://account.r2.cloudflarestorage.com',
      WORKSPACE_ARTIFACTS_BUCKET_NAME: 'kilocode-workspace-artifacts',
      WORKSPACE_ARTIFACTS_READONLY_ACCESS_KEY_ID: 'test-access-key',
      WORKSPACE_ARTIFACTS_READONLY_SECRET_ACCESS_KEY: 'test-secret-key',
      ...options.env,
    },
  } as unknown as TRPCContext;

  return {
    caller: appRouter.createCaller(context),
    session,
    sessionStub,
    control,
    controlStub,
  };
}

describe('Worker workspace artifact procedures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryAccess.mockResolvedValue(access);
  });

  describe('listWorkspaceArtifacts', () => {
    it('resolves the session sandbox and returns the index without preparing a sandbox', async () => {
      const harness = setup();

      await expect(
        harness.caller.listWorkspaceArtifacts({ cloudAgentSessionId: sessionId })
      ).resolves.toEqual(list);

      expect(queryAccess).toHaveBeenCalledWith(expect.anything(), {
        kiloUserId: 'user_owner',
        cloudAgentSessionId: sessionId,
      });
      expect(harness.session.idFromName).toHaveBeenCalledWith(`user_owner:${sessionId}`);
      expect(harness.control.getByName).toHaveBeenCalledWith(sandboxId);
      expect(harness.controlStub.listWorkspaceArtifacts).toHaveBeenCalledTimes(1);
    });

    it('derives the deterministic sandbox id when the session has no workspace sandbox yet', async () => {
      const harness = setup({
        metadata: {
          ...metadata,
          workspace: undefined,
        } as unknown as SessionMetadata,
      });

      await expect(
        harness.caller.listWorkspaceArtifacts({ cloudAgentSessionId: sessionId })
      ).resolves.toEqual(list);

      expect(harness.control.getByName).toHaveBeenCalledWith(expect.stringMatching(/^ses-/));
    });

    it('rejects an unauthenticated request before access lookup or DO routing', async () => {
      const harness = setup({ userId: '' });
      await expect(
        harness.caller.listWorkspaceArtifacts({ cloudAgentSessionId: sessionId })
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      expect(queryAccess).not.toHaveBeenCalled();
      expect(harness.session.get).not.toHaveBeenCalled();
      expect(harness.control.getByName).not.toHaveBeenCalled();
    });

    it('rejects denied access before resolving the sandbox', async () => {
      queryAccess.mockResolvedValue(null);
      const harness = setup();
      await expect(
        harness.caller.listWorkspaceArtifacts({ cloudAgentSessionId: sessionId })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(harness.session.get).not.toHaveBeenCalled();
      expect(harness.control.getByName).not.toHaveBeenCalled();
    });

    it('fails closed when the access lookup is unavailable', async () => {
      queryAccess.mockRejectedValueOnce(new Error('database unavailable'));
      const harness = setup();
      await expect(
        harness.caller.listWorkspaceArtifacts({ cloudAgentSessionId: sessionId })
      ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
      expect(harness.session.get).not.toHaveBeenCalled();
    });

    it('rejects a session owned by another user before routing to the sandbox', async () => {
      const harness = setup({
        metadata: {
          ...metadata,
          identity: { sessionId, userId: 'user_other', orgId: 'org_current' },
        } as unknown as SessionMetadata,
      });
      await expect(
        harness.caller.listWorkspaceArtifacts({ cloudAgentSessionId: sessionId })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(harness.control.getByName).not.toHaveBeenCalled();
    });

    it('rejects retired session ids before authorization', async () => {
      const harness = setup();
      await expect(
        harness.caller.listWorkspaceArtifacts({ cloudAgentSessionId: legacySessionId })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(queryAccess).not.toHaveBeenCalled();
      expect(harness.session.get).not.toHaveBeenCalled();
    });
  });

  describe('getWorkspaceArtifactDownloadUrl', () => {
    it('signs a forced attachment with an RFC 5987 filename', async () => {
      const harness = setup();
      const relativePath = 'reports/week (final).pdf';

      const result = await harness.caller.getWorkspaceArtifactDownloadUrl({
        cloudAgentSessionId: sessionId,
        relativePath,
      });

      expect(harness.controlStub.getWorkspaceArtifact).toHaveBeenCalledWith(relativePath);
      expect(getSignedURL).toHaveBeenCalledWith(
        'kilocode-workspace-artifacts',
        `${sandboxId}/object`,
        300,
        {
          responseContentDisposition: "attachment; filename*=UTF-8''week%20%28final%29.pdf",
        }
      );
      expect(result.url).toBe('https://account.r2.cloudflarestorage.com/signed');
      expect(result.expiresAt).toBeGreaterThan(Date.now() - 1_000);
    });

    it.each([
      ['text/html', 'report.html'],
      ['image/svg+xml', 'diagram.svg'],
      ['application/xml', 'data.xml'],
      ['application/xhtml+xml', 'page.xhtml'],
    ])('forces %s to octet-stream', async (contentType, relativePath) => {
      const harness = setup();
      harness.controlStub.getWorkspaceArtifact.mockResolvedValue({
        objectKey: `${sandboxId}/object`,
        entry: { ...entry, relativePath, contentType },
      });

      await harness.caller.getWorkspaceArtifactDownloadUrl({
        cloudAgentSessionId: sessionId,
        relativePath,
      });

      expect(getSignedURL).toHaveBeenCalledWith(
        'kilocode-workspace-artifacts',
        `${sandboxId}/object`,
        300,
        expect.objectContaining({ responseContentType: 'application/octet-stream' })
      );
    });

    it('does not override the content type for safe files', async () => {
      const harness = setup();

      await harness.caller.getWorkspaceArtifactDownloadUrl({
        cloudAgentSessionId: sessionId,
        relativePath: entry.relativePath,
      });

      expect(getSignedURL).toHaveBeenCalledWith(
        'kilocode-workspace-artifacts',
        `${sandboxId}/object`,
        300,
        { responseContentDisposition: "attachment; filename*=UTF-8''weekly.pdf" }
      );
    });

    it('rejects an unknown path without signing a URL', async () => {
      const harness = setup();
      harness.controlStub.getWorkspaceArtifact.mockResolvedValue(null);

      await expect(
        harness.caller.getWorkspaceArtifactDownloadUrl({
          cloudAgentSessionId: sessionId,
          relativePath: 'missing.pdf',
        })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(createR2Client).not.toHaveBeenCalled();
      expect(getSignedURL).not.toHaveBeenCalled();
    });

    it('returns an explicit error when download signing is not configured', async () => {
      const harness = setup({
        env: {
          WORKSPACE_ARTIFACTS_READONLY_ACCESS_KEY_ID: undefined,
          WORKSPACE_ARTIFACTS_READONLY_SECRET_ACCESS_KEY: undefined,
        },
      });

      await expect(
        harness.caller.getWorkspaceArtifactDownloadUrl({
          cloudAgentSessionId: sessionId,
          relativePath: entry.relativePath,
        })
      ).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        message: 'Workspace artifact downloads are not configured',
      });
      expect(harness.controlStub.getWorkspaceArtifact).not.toHaveBeenCalled();
      expect(getSignedURL).not.toHaveBeenCalled();
    });

    it('rejects denied access before looking up the object', async () => {
      queryAccess.mockResolvedValue(null);
      const harness = setup();

      await expect(
        harness.caller.getWorkspaceArtifactDownloadUrl({
          cloudAgentSessionId: sessionId,
          relativePath: entry.relativePath,
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(harness.controlStub.getWorkspaceArtifact).not.toHaveBeenCalled();
      expect(getSignedURL).not.toHaveBeenCalled();
    });
  });

  describe('deleteWorkspaceArtifact', () => {
    it('deletes through the offline-safe user RPC', async () => {
      const harness = setup();

      await expect(
        harness.caller.deleteWorkspaceArtifact({
          cloudAgentSessionId: sessionId,
          relativePath: entry.relativePath,
          expectedHash: entry.contentHash,
        })
      ).resolves.toEqual({ status: 'deleted', revision: 4 });

      expect(harness.controlStub.deleteWorkspaceArtifactForUser).toHaveBeenCalledWith({
        relativePath: entry.relativePath,
        expectedHash: entry.contentHash,
      });
    });

    it('rejects a malformed expected hash before access lookup', async () => {
      const harness = setup();

      await expect(
        harness.caller.deleteWorkspaceArtifact({
          cloudAgentSessionId: sessionId,
          relativePath: entry.relativePath,
          expectedHash: 'not-a-hash',
        })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(queryAccess).not.toHaveBeenCalled();
      expect(harness.controlStub.deleteWorkspaceArtifactForUser).not.toHaveBeenCalled();
    });

    it('rejects denied access before deleting', async () => {
      queryAccess.mockResolvedValue(null);
      const harness = setup();

      await expect(
        harness.caller.deleteWorkspaceArtifact({
          cloudAgentSessionId: sessionId,
          relativePath: entry.relativePath,
          expectedHash: entry.contentHash,
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(harness.controlStub.deleteWorkspaceArtifactForUser).not.toHaveBeenCalled();
    });
  });
});
