import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  cli_sessions_v2,
  cloud_agent_workspace_folders,
  cloud_agent_worktrees,
  kilocode_users,
  organization_memberships,
  organizations,
  type User,
} from '@kilocode/db/schema';
import type { CloudAgentAuthority } from '@kilocode/worker-utils/cloud-agent-authority';
import type * as CloudAgentClientModule from '@/lib/cloud-agent-next/cloud-agent-client';
import { TRPCClientError } from '@trpc/client';
import { eq, inArray } from 'drizzle-orm';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  createCallerFactory,
  createTRPCRouter,
  type TRPCContext,
} from '@kilocode/web-shared/lib/trpc/init';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';

const mockGetSession = jest.fn<(sessionId: string, organizationId?: string) => Promise<unknown>>();
const mockListChildSessions = jest.fn<(input: unknown) => Promise<unknown>>();
const mockClient = {
  getSession: mockGetSession,
  listChildSessions: mockListChildSessions,
};
const mockCreateCloudAgentNextClient = jest.fn<() => typeof mockClient>(() => mockClient);
const mockCreateControlTokenForRequest = jest.fn<
  (user: User, resource: string, options: unknown) => Promise<{ token: string }>
>(async () => ({ token: 'scoped-worker-token' }));

jest.mock('@/lib/auth/resource-delegation', () => ({
  createControlTokenForRequest: (...args: Parameters<typeof mockCreateControlTokenForRequest>) =>
    mockCreateControlTokenForRequest(...args),
}));

jest.mock('@/lib/cloud-agent-next/cloud-agent-client', () => ({
  createCloudAgentNextClient: () => mockCreateCloudAgentNextClient(),
  rethrowCloudAgentError: jest.requireActual<typeof CloudAgentClientModule>(
    '@/lib/cloud-agent-next/cloud-agent-client'
  ).rethrowCloudAgentError,
}));

const USER_ID = 'oauth/github|scoped-folder-owner';
const OTHER_USER_ID = 'oauth/github|other-scoped-folder-owner';
const ORGANIZATION_ID = '3c384401-b75d-4375-a1ba-e319a02e18b7';
const OTHER_ORGANIZATION_ID = '4c384401-b75d-4375-a1ba-e319a02e18b7';
const PARENT_SESSION_ID = 'workspace_9a345678-1234-4234-9234-123456789abc';
const INITIAL_TIME = '2026-08-26T00:00:00.000Z';
const LATER_TIME = '2026-08-26T01:00:00.000Z';

let user: User;
let otherUser: User;

async function buildCaller() {
  const { workspaceFoldersRouter } = await import('./workspace-folders-router');
  return createCallerFactory(createTRPCRouter({ workspaceFolders: workspaceFoldersRouter }));
}
let createCaller: Awaited<ReturnType<typeof buildCaller>>;

function authorityFor(organizationId: string | null): CloudAgentAuthority {
  return {
    version: 1,
    ownerId: USER_ID,
    parentSessionId: PARENT_SESSION_ID,
    organizationId,
    authorizationId: '6a345678-1234-4234-9234-123456789abc',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
}

function callerFor(cloudAgentAuthority?: CloudAgentAuthority, account = user) {
  return createCaller({
    user: account,
    cloudAgentAuthority,
    headersList: new Headers({ authorization: 'Bearer scoped-token' }),
  } as TRPCContext);
}

function newWorktreeId(): `worktree_${string}` {
  return `worktree_${crypto.randomUUID()}`;
}

async function insertWorkspaceSession(
  overrides: {
    kiloUserId?: string;
    organizationId?: string | null;
    worktreeId?: `worktree_${string}`;
    cloudAgentSessionId?: `workspace_${string}`;
  } = {}
) {
  const cloudAgentSessionId: `workspace_${string}` =
    overrides.cloudAgentSessionId ?? `workspace_${crypto.randomUUID()}`;
  const worktreeId = overrides.worktreeId ?? newWorktreeId();
  await db.insert(cli_sessions_v2).values({
    session_id: `ses_${crypto.randomUUID().replaceAll('-', '').slice(0, 26)}`,
    kilo_user_id: overrides.kiloUserId ?? USER_ID,
    organization_id: overrides.organizationId ?? null,
    cloud_agent_session_id: cloudAgentSessionId,
    cloud_agent_worktree_id: worktreeId,
    created_on_platform: 'cloud-agent-web',
    created_at: INITIAL_TIME,
    updated_at: INITIAL_TIME,
  });
  return { cloudAgentSessionId, worktreeId };
}

function liveChild(
  child: { cloudAgentSessionId: string; worktreeId: string },
  orgId?: string,
  userId = USER_ID
) {
  mockGetSession.mockResolvedValue({
    sessionId: child.cloudAgentSessionId,
    userId,
    ...(orgId === undefined ? {} : { orgId }),
    worktreeId: child.worktreeId,
  });
}

async function createFolder(organizationId: string | null = null, name = 'Folder') {
  return callerFor().workspaceFolders.create({ organizationId, name, color: 'default' });
}

async function readWorktree(worktreeId: string) {
  const [worktree] = await db
    .select()
    .from(cloud_agent_worktrees)
    .where(eq(cloud_agent_worktrees.worktree_id, worktreeId));
  return worktree;
}

async function readFolders() {
  return db
    .select()
    .from(cloud_agent_workspace_folders)
    .where(eq(cloud_agent_workspace_folders.kilo_user_id, USER_ID));
}

beforeAll(async () => {
  user = await insertTestUser({ id: USER_ID, is_admin: false });
  otherUser = await insertTestUser({ id: OTHER_USER_ID, is_admin: false });
  await db.insert(organizations).values([
    { id: ORGANIZATION_ID, name: 'Scoped folder organization', created_by_kilo_user_id: USER_ID },
    {
      id: OTHER_ORGANIZATION_ID,
      name: 'Other scoped folder organization',
      created_by_kilo_user_id: USER_ID,
    },
  ]);
  createCaller = await buildCaller();
});

beforeEach(async () => {
  jest.clearAllMocks();
  mockCreateCloudAgentNextClient.mockReturnValue(mockClient);
  mockCreateControlTokenForRequest.mockResolvedValue({ token: 'scoped-worker-token' });
  mockListChildSessions.mockResolvedValue({ sessions: [] });
  mockGetSession.mockReset();

  const userIds = [USER_ID, OTHER_USER_ID];
  await db.delete(cli_sessions_v2).where(inArray(cli_sessions_v2.kilo_user_id, userIds));
  await db
    .delete(cloud_agent_worktrees)
    .where(inArray(cloud_agent_worktrees.kilo_user_id, userIds));
  await db
    .delete(cloud_agent_workspace_folders)
    .where(inArray(cloud_agent_workspace_folders.kilo_user_id, userIds));
  await db
    .delete(organization_memberships)
    .where(inArray(organization_memberships.kilo_user_id, userIds));
  await db
    .update(kilocode_users)
    .set({ blocked_reason: null })
    .where(inArray(kilocode_users.id, userIds));
  await db
    .update(organizations)
    .set({ deleted_at: null })
    .where(inArray(organizations.id, [ORGANIZATION_ID, OTHER_ORGANIZATION_ID]));
  await db.insert(organization_memberships).values([
    { kilo_user_id: USER_ID, organization_id: ORGANIZATION_ID, role: 'member' },
    { kilo_user_id: USER_ID, organization_id: OTHER_ORGANIZATION_ID, role: 'member' },
    { kilo_user_id: OTHER_USER_ID, organization_id: ORGANIZATION_ID, role: 'member' },
  ]);
});

describe('scoped workspace folder moves', () => {
  it.each([null, ORGANIZATION_ID] as const)(
    'moves a direct child workspace into a folder in scope %p',
    async organizationId => {
      const folder = await createFolder(organizationId);
      const child = await insertWorkspaceSession({ organizationId });
      liveChild(child, organizationId ?? undefined);

      await expect(
        callerFor(authorityFor(organizationId)).workspaceFolders.moveWorktree({
          organizationId,
          cloudAgentSessionId: child.cloudAgentSessionId,
          worktreeId: child.worktreeId,
          folderId: folder.id,
        })
      ).resolves.toEqual({ success: true });

      expect(await readWorktree(child.worktreeId)).toMatchObject({
        kilo_user_id: USER_ID,
        organization_id: organizationId,
        folder_id: folder.id,
      });
      expect(mockCreateControlTokenForRequest).toHaveBeenCalledWith(
        user,
        'cloud-agent-next',
        expect.objectContaining({ tokenSource: 'cloud-agent', headers: expect.any(Headers) })
      );
      expect(mockGetSession).toHaveBeenCalledWith(
        child.cloudAgentSessionId,
        organizationId ?? undefined
      );
    }
  );

  it('rejects the parent session even when the remote response is forged to match', async () => {
    const folder = await createFolder();
    const { worktreeId } = await insertWorkspaceSession({ cloudAgentSessionId: PARENT_SESSION_ID });
    await db
      .insert(cloud_agent_worktrees)
      .values({ worktree_id: worktreeId, kilo_user_id: USER_ID });
    const original = await readWorktree(worktreeId);
    mockGetSession.mockResolvedValue({
      sessionId: PARENT_SESSION_ID,
      userId: USER_ID,
      worktreeId,
    });

    await expect(
      callerFor(authorityFor(null)).workspaceFolders.moveWorktree({
        organizationId: null,
        cloudAgentSessionId: PARENT_SESSION_ID,
        worktreeId,
        folderId: folder.id,
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mockGetSession).not.toHaveBeenCalled();
    expect(await readWorktree(worktreeId)).toEqual(original);
  });

  it('rejects an unrelated owned worktree when the child worktree differs', async () => {
    const folder = await createFolder();
    const child = await insertWorkspaceSession();
    const unrelated = await insertWorkspaceSession();
    liveChild(child);

    await expect(
      callerFor(authorityFor(null)).workspaceFolders.moveWorktree({
        organizationId: null,
        cloudAgentSessionId: child.cloudAgentSessionId,
        worktreeId: unrelated.worktreeId,
        folderId: folder.id,
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await readWorktree(unrelated.worktreeId)).toBeUndefined();
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['mismatched', 'other'],
  ] as const)('rejects a remote %s worktree before writing', async (_name, worktree) => {
    const folder = await createFolder();
    const child = await insertWorkspaceSession();
    mockGetSession.mockResolvedValue({
      sessionId: child.cloudAgentSessionId,
      userId: USER_ID,
      worktreeId: worktree === 'other' ? newWorktreeId() : worktree,
    });

    await expect(
      callerFor(authorityFor(null)).workspaceFolders.moveWorktree({
        organizationId: null,
        cloudAgentSessionId: child.cloudAgentSessionId,
        worktreeId: child.worktreeId,
        folderId: folder.id,
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await readWorktree(child.worktreeId)).toBeUndefined();
    expect(await readFolders()).toHaveLength(1);
  });

  it('rejects a remote session bound to another user or organization', async () => {
    const folder = await createFolder();
    const child = await insertWorkspaceSession();
    for (const session of [
      { sessionId: child.cloudAgentSessionId, userId: OTHER_USER_ID, worktreeId: child.worktreeId },
      {
        sessionId: child.cloudAgentSessionId,
        userId: USER_ID,
        orgId: ORGANIZATION_ID,
        worktreeId: child.worktreeId,
      },
    ]) {
      mockGetSession.mockResolvedValue(session);
      await expect(
        callerFor(authorityFor(null)).workspaceFolders.moveWorktree({
          organizationId: null,
          cloudAgentSessionId: child.cloudAgentSessionId,
          worktreeId: child.worktreeId,
          folderId: folder.id,
        })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }
    expect(await readWorktree(child.worktreeId)).toBeUndefined();
  });

  it('rejects a local child row owned by another user', async () => {
    const folder = await createFolder();
    const child = await insertWorkspaceSession({ kiloUserId: OTHER_USER_ID });
    liveChild(child);

    await expect(
      callerFor(authorityFor(null)).workspaceFolders.moveWorktree({
        organizationId: null,
        cloudAgentSessionId: child.cloudAgentSessionId,
        worktreeId: child.worktreeId,
        folderId: folder.id,
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await readWorktree(child.worktreeId)).toBeUndefined();
  });

  it('rejects a local child row from another organization', async () => {
    const folder = await createFolder();
    const child = await insertWorkspaceSession({ organizationId: ORGANIZATION_ID });
    liveChild(child);

    await expect(
      callerFor(authorityFor(null)).workspaceFolders.moveWorktree({
        organizationId: null,
        cloudAgentSessionId: child.cloudAgentSessionId,
        worktreeId: child.worktreeId,
        folderId: folder.id,
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await readWorktree(child.worktreeId)).toBeUndefined();
  });

  it('rejects when the local child row worktree binding does not match', async () => {
    const folder = await createFolder();
    const child = await insertWorkspaceSession();
    const requestedWorktreeId = newWorktreeId();
    mockGetSession.mockResolvedValue({
      sessionId: child.cloudAgentSessionId,
      userId: USER_ID,
      worktreeId: requestedWorktreeId,
    });

    await expect(
      callerFor(authorityFor(null)).workspaceFolders.moveWorktree({
        organizationId: null,
        cloudAgentSessionId: child.cloudAgentSessionId,
        worktreeId: requestedWorktreeId,
        folderId: folder.id,
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await readWorktree(requestedWorktreeId)).toBeUndefined();
    expect(await readWorktree(child.worktreeId)).toBeUndefined();
  });

  it('does not write when the delegated token or Worker revalidation fails', async () => {
    const folder = await createFolder();
    const child = await insertWorkspaceSession();

    mockCreateControlTokenForRequest.mockRejectedValueOnce(new Error('authority revoked'));
    await expect(
      callerFor(authorityFor(null)).workspaceFolders.moveWorktree({
        organizationId: null,
        cloudAgentSessionId: child.cloudAgentSessionId,
        worktreeId: child.worktreeId,
        folderId: folder.id,
      })
    ).rejects.toThrow('authority revoked');
    expect(await readWorktree(child.worktreeId)).toBeUndefined();

    mockGetSession.mockRejectedValueOnce(new Error('Worker unavailable'));
    await expect(
      callerFor(authorityFor(null)).workspaceFolders.moveWorktree({
        organizationId: null,
        cloudAgentSessionId: child.cloudAgentSessionId,
        worktreeId: child.worktreeId,
        folderId: folder.id,
      })
    ).rejects.toThrow('Worker unavailable');
    expect(await readWorktree(child.worktreeId)).toBeUndefined();
  });

  it.each(['list', 'move'] as const)(
    'preserves an upstream parent revocation reason for %s',
    async action => {
      const child = await insertWorkspaceSession();
      const refusal = new TRPCClientError('Parent authority was revoked', {
        result: {
          error: {
            code: -32003,
            message: 'Parent authority was revoked',
            data: { code: 'FORBIDDEN', httpStatus: 403 },
          },
        },
      });
      const caller = callerFor(authorityFor(null));
      if (action === 'list') {
        mockListChildSessions.mockRejectedValueOnce(refusal);
        await expect(caller.workspaceFolders.list({ organizationId: null })).rejects.toMatchObject({
          code: 'FORBIDDEN',
          message: 'Parent authority was revoked',
        });
      } else {
        mockGetSession.mockRejectedValueOnce(refusal);
        await expect(
          caller.workspaceFolders.moveWorktree({
            organizationId: null,
            cloudAgentSessionId: child.cloudAgentSessionId,
            worktreeId: child.worktreeId,
            folderId: null,
          })
        ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'Parent authority was revoked' });
      }
      expect(await readWorktree(child.worktreeId)).toBeUndefined();
    }
  );

  it('rejects a missing child workspace before the transaction', async () => {
    const folder = await createFolder();
    const child = await insertWorkspaceSession();
    liveChild(child);

    await expect(
      callerFor(authorityFor(null)).workspaceFolders.moveWorktree({
        organizationId: null,
        worktreeId: child.worktreeId,
        folderId: folder.id,
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockGetSession).not.toHaveBeenCalled();
    expect(await readWorktree(child.worktreeId)).toBeUndefined();
  });

  it('rejects a folder owned by another user', async () => {
    const folder = await callerFor(undefined, otherUser).workspaceFolders.create({
      organizationId: null,
      name: 'Foreign',
      color: 'default',
    });
    const child = await insertWorkspaceSession();
    liveChild(child);

    await expect(
      callerFor(authorityFor(null)).workspaceFolders.moveWorktree({
        organizationId: null,
        cloudAgentSessionId: child.cloudAgentSessionId,
        worktreeId: child.worktreeId,
        folderId: folder.id,
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await readWorktree(child.worktreeId)).toBeUndefined();
  });

  it('rejects a folder from another scope', async () => {
    const folder = await createFolder(ORGANIZATION_ID);
    const child = await insertWorkspaceSession();
    liveChild(child);

    await expect(
      callerFor(authorityFor(null)).workspaceFolders.moveWorktree({
        organizationId: null,
        cloudAgentSessionId: child.cloudAgentSessionId,
        worktreeId: child.worktreeId,
        folderId: folder.id,
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await readWorktree(child.worktreeId)).toBeUndefined();
  });

  it('rejects a folder that was deleted', async () => {
    const folder = await createFolder();
    await callerFor().workspaceFolders.delete({ organizationId: null, folderId: folder.id });
    const child = await insertWorkspaceSession();
    liveChild(child);

    await expect(
      callerFor(authorityFor(null)).workspaceFolders.moveWorktree({
        organizationId: null,
        cloudAgentSessionId: child.cloudAgentSessionId,
        worktreeId: child.worktreeId,
        folderId: folder.id,
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await readWorktree(child.worktreeId)).toBeUndefined();
  });

  it('rejects moves into a deleted organization without writing', async () => {
    const folder = await createFolder(ORGANIZATION_ID);
    const child = await insertWorkspaceSession({ organizationId: ORGANIZATION_ID });
    liveChild(child, ORGANIZATION_ID);
    await db
      .update(organizations)
      .set({ deleted_at: LATER_TIME })
      .where(eq(organizations.id, ORGANIZATION_ID));

    await expect(
      callerFor(authorityFor(ORGANIZATION_ID)).workspaceFolders.moveWorktree({
        organizationId: ORGANIZATION_ID,
        cloudAgentSessionId: child.cloudAgentSessionId,
        worktreeId: child.worktreeId,
        folderId: folder.id,
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await readWorktree(child.worktreeId)).toBeUndefined();
  });
});

describe('scoped workspace folder listing', () => {
  it('withholds saved smart-folder workspace order from scoped callers', async () => {
    const folder = await callerFor().workspaceFolders.create({
      organizationId: null,
      name: 'Needs you',
      color: 'orange',
      smartPreset: 'needs_you',
    });
    const child = await insertWorkspaceSession();
    await db.insert(cloud_agent_worktrees).values({
      worktree_id: child.worktreeId,
      kilo_user_id: USER_ID,
    });
    await callerFor().workspaceFolders.reorderWorktrees({
      organizationId: null,
      folderId: folder.id,
      worktreeIds: [child.worktreeId],
    });
    await expect(
      callerFor(authorityFor(null)).workspaceFolders.list({ organizationId: null })
    ).resolves.toEqual({ folders: [{ ...folder, manualWorktreeOrder: [] }] });
    await expect(callerFor().workspaceFolders.list({ organizationId: null })).resolves.toEqual({
      folders: [{ ...folder, manualWorktreeOrder: [child.worktreeId] }],
    });
  });

  it('withholds worktree IDs from a scoped list and keeps them for ordinary callers', async () => {
    const folder = await createFolder();
    const child = await insertWorkspaceSession();
    liveChild(child);
    await callerFor(authorityFor(null)).workspaceFolders.moveWorktree({
      organizationId: null,
      cloudAgentSessionId: child.cloudAgentSessionId,
      worktreeId: child.worktreeId,
      folderId: folder.id,
    });
    mockListChildSessions.mockResolvedValue({ sessions: [] });

    await expect(
      callerFor(authorityFor(null)).workspaceFolders.list({ organizationId: null })
    ).resolves.toEqual({ folders: [{ ...folder, worktreeIds: [] }] });
    expect(mockListChildSessions).toHaveBeenCalledWith({ limit: 1 });

    await expect(callerFor().workspaceFolders.list({ organizationId: null })).resolves.toEqual({
      folders: [{ ...folder, worktreeIds: [child.worktreeId] }],
    });
  });

  it('passes the signed organization when revalidating an organization scope', async () => {
    const folder = await createFolder(ORGANIZATION_ID);
    await expect(
      callerFor(authorityFor(ORGANIZATION_ID)).workspaceFolders.list({
        organizationId: ORGANIZATION_ID,
      })
    ).resolves.toEqual({ folders: [{ ...folder, worktreeIds: [] }] });
    expect(mockListChildSessions).toHaveBeenCalledWith({
      limit: 1,
      organizationId: ORGANIZATION_ID,
    });
    expect(mockCreateControlTokenForRequest).toHaveBeenCalledWith(
      user,
      'cloud-agent-next',
      expect.objectContaining({ organizationId: ORGANIZATION_ID })
    );
  });

  it('fails closed when the live parent cannot be revalidated', async () => {
    await createFolder();
    mockListChildSessions.mockRejectedValueOnce(new Error('parent revoked'));
    await expect(
      callerFor(authorityFor(null)).workspaceFolders.list({ organizationId: null })
    ).rejects.toThrow('parent revoked');
  });
});

describe('scoped workspace folder grants', () => {
  it('does not grant folder creation or reordering', async () => {
    const folder = await createFolder();
    const caller = callerFor(authorityFor(null));

    await expect(
      caller.workspaceFolders.create({ organizationId: null, name: 'Forbidden', color: 'blue' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      caller.workspaceFolders.reorder({ organizationId: null, folderIds: [folder.id] })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      caller.workspaceFolders.reorderWorktrees({
        organizationId: null,
        folderId: folder.id,
        worktreeIds: [],
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await readFolders()).toHaveLength(1);
  });
});

describe('ordinary workspace folder moves', () => {
  it('keeps the existing behavior when cloudAgentSessionId is supplied', async () => {
    const folder = await createFolder();
    const child = await insertWorkspaceSession();

    await expect(
      callerFor().workspaceFolders.moveWorktree({
        organizationId: null,
        cloudAgentSessionId: child.cloudAgentSessionId,
        worktreeId: child.worktreeId,
        folderId: folder.id,
      })
    ).resolves.toEqual({ success: true });

    expect(await readWorktree(child.worktreeId)).toMatchObject({ folder_id: folder.id });
    expect(mockCreateControlTokenForRequest).not.toHaveBeenCalled();
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it('keeps rejecting a move without a surviving owned root', async () => {
    const folder = await createFolder();
    const worktreeId = newWorktreeId();
    await expect(
      callerFor().workspaceFolders.moveWorktree({
        organizationId: null,
        worktreeId,
        folderId: folder.id,
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await readWorktree(worktreeId)).toBeUndefined();
  });
});
