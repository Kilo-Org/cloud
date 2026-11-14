import type {
  CloudAgentRootSessionSummary,
  CloudAgentWorkspaceSummary,
} from '@kilocode/session-ingest-contracts';
import { describe, expect, it, vi } from 'vitest';
import type { PreviewTargetResult } from '../control-plane/sandbox/preview-target.js';
import { parseSessionMetadata, type SessionMetadata } from '../persistence/session-metadata.js';
import type { Env } from '../types.js';
import {
  requireCurrentWorkspaceAccess,
  resolveWorkspacePreviewTarget,
} from './workspace-target.js';

const OWNER = 'oauth/google:workspace-owner';
const WORKSPACE_ID = 'worktree_11111111-1111-4111-8111-111111111111';
const OTHER_WORKSPACE_ID = 'worktree_99999999-9999-4999-8999-999999999999';
const SESSION_ID = 'workspace_22222222-2222-4222-8222-222222222222';
const OTHER_SESSION_ID = 'workspace_99999999-9999-4999-8999-999999999999';
const KILO_SESSION_ID = 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa';
const SANDBOX_ID = 'ses-11111111111141118111111111111111';
const ORG_ID = 'org_1';

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
      sessionId: input.sessionId ?? SESSION_ID,
      userId: input.userId ?? OWNER,
      createdOnPlatform: input.platform ?? 'cloud-agent-web',
      ...(input.orgId === undefined ? {} : { orgId: input.orgId }),
    },
    auth: { kiloSessionId: input.kiloSessionId ?? KILO_SESSION_ID },
    agent: { mode: 'code', model: 'test-model' },
    workspace:
      input.sandboxId === null
        ? {
            sandboxProvider: 'cloudflare',
            worktreeId: input.worktreeId ?? WORKSPACE_ID,
          }
        : {
            sandboxId: input.sandboxId ?? SANDBOX_ID,
            sandboxProvider: 'cloudflare-containers',
            worktreeId: input.worktreeId ?? WORKSPACE_ID,
          },
    lifecycle: { version: 1, timestamp: 1 },
  });
}

function rootSession(
  overrides: Partial<CloudAgentRootSessionSummary> = {}
): CloudAgentRootSessionSummary {
  return {
    kiloSessionId: KILO_SESSION_ID,
    cloudAgentSessionId: SESSION_ID,
    workspaceId: WORKSPACE_ID,
    userId: OWNER,
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
    workspaceId: WORKSPACE_ID,
    userId: OWNER,
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

const COORDINATES: PreviewTargetResult = {
  status: 'ok' as const,
  coordinates: {
    provider: 'cloudflare-containers' as const,
    logicalSandboxId: SANDBOX_ID,
    allocationRef: 'allocation-ref',
  },
};

function fixture(
  input: {
    workspace?: CloudAgentWorkspaceSummary | null;
    metadata?: SessionMetadata | null;
    expectedOrganizationId?: string | null;
  } = {}
) {
  const getCloudAgentWorkspace = vi.fn(async () =>
    'workspace' in input ? (input.workspace ?? null) : workspaceSummary()
  );
  const getMetadata = vi.fn(async () =>
    input.metadata === undefined ? sessionMetadata() : input.metadata
  );
  const previewTarget = vi.fn(async (): Promise<PreviewTargetResult> => COORDINATES);
  const idFromName = vi.fn((name: string) => name);
  const sessionGet = vi.fn((_id: string) => ({ getMetadata }));
  const getByName = vi.fn((_sandboxId: string) => ({ previewTarget }));
  const env = {
    SESSION_INGEST: { getCloudAgentWorkspace },
    SANDBOX_SESSION: { idFromName, get: sessionGet },
    SANDBOX_CONTROL: { getByName },
  } as unknown as Env;
  const request = {
    env,
    kiloUserId: OWNER,
    worktreeId: WORKSPACE_ID,
    expectedOrganizationId: input.expectedOrganizationId ?? null,
  };
  return {
    request,
    getCloudAgentWorkspace,
    getMetadata,
    previewTarget,
    idFromName,
    sessionGet,
    getByName,
  };
}

describe('requireCurrentWorkspaceAccess', () => {
  it('accepts an active workspace owned by the current user', async () => {
    const test = fixture();
    await expect(requireCurrentWorkspaceAccess(test.request)).resolves.toMatchObject({
      workspaceId: WORKSPACE_ID,
      userId: OWNER,
      deletionState: 'active',
    });
    expect(test.getCloudAgentWorkspace).toHaveBeenCalledWith({
      kiloUserId: OWNER,
      workspaceId: WORKSPACE_ID,
      sessionLimit: 1,
    });
  });

  it.each([
    ['missing', null],
    ['owned by another user', workspaceSummary({ userId: 'other' })],
    ['for another organization', workspaceSummary({ organizationId: ORG_ID })],
    ['being deleted', workspaceSummary({ deletionState: 'deleting' as const })],
    ['already deleted', workspaceSummary({ deletionState: 'deleted' as const })],
    ['for another workspace id', workspaceSummary({ workspaceId: OTHER_WORKSPACE_ID })],
  ])('denies a workspace that is %s', async (_name, workspace) => {
    const test = fixture({ workspace });
    await expect(requireCurrentWorkspaceAccess(test.request)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('reports a transient session-ingest failure as unavailable', async () => {
    const test = fixture();
    test.getCloudAgentWorkspace.mockRejectedValueOnce(new Error('rpc down'));
    await expect(requireCurrentWorkspaceAccess(test.request)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
  });
});

describe('resolveWorkspacePreviewTarget', () => {
  it('uses a newly registered sibling as a placement locator without its execution route', async () => {
    const test = fixture({
      workspace: workspaceSummary({
        sessions: [rootSession({ cloudAgentSessionId: OTHER_SESSION_ID })],
      }),
      metadata: sessionMetadata({ sessionId: OTHER_SESSION_ID }),
    });
    await expect(resolveWorkspacePreviewTarget(test.request)).resolves.toEqual(COORDINATES);
    expect(test.idFromName).toHaveBeenCalledWith(`${OWNER}:${OTHER_SESSION_ID}`);
    expect(test.previewTarget).toHaveBeenCalledWith({
      ownerId: OWNER,
      organizationId: null,
      scopeId: WORKSPACE_ID,
    });
  });

  it('resolves the first catalog root allocation without requiring a preview route', async () => {
    const test = fixture({
      workspace: workspaceSummary({
        sessions: [
          rootSession(),
          rootSession({
            cloudAgentSessionId: OTHER_SESSION_ID,
            kiloSessionId: 'ses_bbbbbbbbbbbbbbbbbbbbbbbbbb',
          }),
        ],
      }),
    });

    await expect(resolveWorkspacePreviewTarget(test.request)).resolves.toEqual(COORDINATES);
    expect(test.getMetadata).toHaveBeenCalledTimes(1);
    expect(test.idFromName).toHaveBeenCalledWith(`${OWNER}:${SESSION_ID}`);
    expect(test.getByName).toHaveBeenCalledWith(SANDBOX_ID);
    expect(test.previewTarget).toHaveBeenCalledWith({
      ownerId: OWNER,
      organizationId: null,
      scopeId: WORKSPACE_ID,
    });
  });

  it('passes the expected organization through to the sandbox scope', async () => {
    const test = fixture({
      workspace: workspaceSummary({
        organizationId: ORG_ID,
        sessions: [rootSession({ organizationId: ORG_ID })],
      }),
      metadata: sessionMetadata({ orgId: ORG_ID }),
      expectedOrganizationId: ORG_ID,
    });

    await expect(resolveWorkspacePreviewTarget(test.request)).resolves.toEqual(COORDINATES);
    expect(test.previewTarget).toHaveBeenCalledWith({
      ownerId: OWNER,
      organizationId: ORG_ID,
      scopeId: WORKSPACE_ID,
    });
  });

  it('returns not_running when the catalog has no root session', async () => {
    const test = fixture({ workspace: workspaceSummary({ sessions: [] }) });
    await expect(resolveWorkspacePreviewTarget(test.request)).resolves.toEqual({
      status: 'not_running',
    });
    expect(test.sessionGet).not.toHaveBeenCalled();
    expect(test.getByName).not.toHaveBeenCalled();
  });

  it('returns not_ready when the root session has no stored metadata', async () => {
    const test = fixture({ metadata: null });
    await expect(resolveWorkspacePreviewTarget(test.request)).resolves.toEqual({
      status: 'not_ready',
    });
    expect(test.previewTarget).not.toHaveBeenCalled();
  });

  it('returns not_running when the sandbox id is absent', async () => {
    const test = fixture({ metadata: sessionMetadata({ sandboxId: null }) });
    await expect(resolveWorkspacePreviewTarget(test.request)).resolves.toEqual({
      status: 'not_running',
    });
    expect(test.getByName).not.toHaveBeenCalled();
  });

  it('returns ineligible for a non-interactive session without asking the sandbox', async () => {
    const test = fixture({ metadata: sessionMetadata({ platform: 'api' }) });
    await expect(resolveWorkspacePreviewTarget(test.request)).resolves.toEqual({
      status: 'ineligible',
    });
    expect(test.getByName).not.toHaveBeenCalled();
  });

  const mismatches: Array<{
    name: string;
    workspace?: CloudAgentWorkspaceSummary;
    metadata?: SessionMetadata;
    expectedOrganizationId?: string;
  }> = [
    {
      name: 'root user',
      workspace: workspaceSummary({ sessions: [rootSession({ userId: 'other' })] }),
    },
    {
      name: 'root organization',
      workspace: workspaceSummary({
        organizationId: ORG_ID,
        sessions: [rootSession({ organizationId: null })],
      }),
      metadata: sessionMetadata({ orgId: ORG_ID }),
      expectedOrganizationId: ORG_ID,
    },
    {
      name: 'root workspace id',
      workspace: workspaceSummary({
        sessions: [rootSession({ workspaceId: OTHER_WORKSPACE_ID })],
      }),
    },
    {
      name: 'metadata session id',
      metadata: sessionMetadata({ sessionId: OTHER_SESSION_ID }),
    },
    {
      name: 'metadata kilo session id',
      metadata: sessionMetadata({ kiloSessionId: 'ses_other' }),
    },
    {
      name: 'metadata user',
      metadata: sessionMetadata({ userId: 'other' }),
    },
    {
      name: 'metadata organization',
      workspace: workspaceSummary({
        organizationId: ORG_ID,
        sessions: [rootSession({ organizationId: ORG_ID })],
      }),
      metadata: sessionMetadata(),
      expectedOrganizationId: ORG_ID,
    },
    {
      name: 'metadata worktree',
      metadata: sessionMetadata({ worktreeId: OTHER_WORKSPACE_ID }),
    },
  ];

  it.each(mismatches)(
    'denies a $name placement mismatch before asking the sandbox',
    async mismatch => {
      const test = fixture({
        ...(mismatch.workspace === undefined ? {} : { workspace: mismatch.workspace }),
        ...(mismatch.metadata === undefined ? {} : { metadata: mismatch.metadata }),
        ...(mismatch.expectedOrganizationId === undefined
          ? {}
          : { expectedOrganizationId: mismatch.expectedOrganizationId }),
      });

      await expect(resolveWorkspacePreviewTarget(test.request)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(test.previewTarget).not.toHaveBeenCalled();
    }
  );

  it('passes a sandbox target failure through unchanged', async () => {
    const test = fixture();
    test.previewTarget.mockResolvedValueOnce({ status: 'not_running' });
    await expect(resolveWorkspacePreviewTarget(test.request)).resolves.toEqual({
      status: 'not_running',
    });
  });
});
