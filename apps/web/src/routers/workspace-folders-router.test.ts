import { beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import {
  cli_sessions_v2,
  cloud_agent_workspace_folders,
  cloud_agent_worktrees,
  kilocode_users,
  organization_memberships,
  organizations,
  type NewCliSessionV2,
  type User,
} from '@kilocode/db/schema';
import {
  createDeletionInProgressBlockedReason,
  createSoftDeletedBlockedReason,
} from '@kilocode/db/user-soft-delete';
import type { CloudAgentWorktreeId } from '@kilocode/session-ingest-contracts';
import { and, asc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import {
  workspaceFolderColorSchema,
  type WorkspaceFolderColor,
} from '@/lib/cloud-agent/workspace-folders';
import { db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { workspaceFoldersRouter } from './workspace-folders-router';

const USER_ID = 'oauth/github|workspace-folder-owner';
const OTHER_USER_ID = 'oauth/github|other-workspace-folder-owner';
const ORGANIZATION_ID = '1c384401-b75d-4375-a1ba-e319a02e18b7';
const OTHER_ORGANIZATION_ID = '2c384401-b75d-4375-a1ba-e319a02e18b7';
const WORKTREE_ID = 'worktree_2a345678-1234-4234-9234-123456789abc';
const WORKSPACE_ID = 'workspace_2a345678-1234-4234-9234-123456789abc';
const SESSION_ID = 'ses_22345678901234567890123456';
const INITIAL_TIME = '2026-08-26T00:00:00.000Z';
const LATER_TIME = '2026-08-26T01:00:00.000Z';

type FolderCaller = ReturnType<typeof workspaceFoldersRouter.createCaller>;
type WorktreeInsert = typeof cloud_agent_worktrees.$inferInsert;
let user: User;
let otherUser: User;

function callerFor(account = user): FolderCaller {
  return workspaceFoldersRouter.createCaller({ user: account });
}

function newWorktreeId(): CloudAgentWorktreeId {
  return `worktree_${crypto.randomUUID()}`;
}

function makeSession(overrides: Partial<NewCliSessionV2> = {}): NewCliSessionV2 {
  return {
    session_id: `ses_${crypto.randomUUID().replaceAll('-', '').slice(0, 26)}`,
    kilo_user_id: USER_ID,
    title: 'Grouped workspace chat',
    organization_id: null,
    cloud_agent_session_id: `workspace_${crypto.randomUUID()}`,
    cloud_agent_worktree_id: WORKTREE_ID,
    created_on_platform: 'cloud-agent-web',
    created_at: INITIAL_TIME,
    updated_at: INITIAL_TIME,
    ...overrides,
  };
}

async function insertSession(overrides: Partial<NewCliSessionV2> = {}) {
  const [session] = await db.insert(cli_sessions_v2).values(makeSession(overrides)).returning();
  if (!session) throw new Error('Session fixture was not inserted');
  return session;
}

async function insertWorktree(overrides: Partial<WorktreeInsert> = {}) {
  const [worktree] = await db
    .insert(cloud_agent_worktrees)
    .values({ worktree_id: WORKTREE_ID, kilo_user_id: USER_ID, ...overrides })
    .returning();
  if (!worktree) throw new Error('Worktree fixture was not inserted');
  return worktree;
}

async function readWorktree(worktreeId = WORKTREE_ID) {
  const [worktree] = await db
    .select()
    .from(cloud_agent_worktrees)
    .where(eq(cloud_agent_worktrees.worktree_id, worktreeId));
  return worktree;
}

function readSessions(worktreeId = WORKTREE_ID) {
  return db
    .select()
    .from(cli_sessions_v2)
    .where(eq(cli_sessions_v2.cloud_agent_worktree_id, worktreeId))
    .orderBy(asc(cli_sessions_v2.session_id));
}

function readFolders(organizationId: string | null = null, userId = USER_ID) {
  return db
    .select()
    .from(cloud_agent_workspace_folders)
    .where(
      and(
        eq(cloud_agent_workspace_folders.kilo_user_id, userId),
        organizationId === null
          ? isNull(cloud_agent_workspace_folders.organization_id)
          : eq(cloud_agent_workspace_folders.organization_id, organizationId)
      )
    )
    .orderBy(asc(cloud_agent_workspace_folders.position), asc(cloud_agent_workspace_folders.id));
}

function createFolder(organizationId: string | null = null, name = 'Folder', account = user) {
  return callerFor(account).create({ organizationId, name, color: 'default' });
}

beforeAll(async () => {
  user = await insertTestUser({ id: USER_ID, is_admin: false });
  otherUser = await insertTestUser({ id: OTHER_USER_ID, is_admin: false });
  await db.insert(organizations).values([
    { id: ORGANIZATION_ID, name: 'Folder organization', created_by_kilo_user_id: USER_ID },
    {
      id: OTHER_ORGANIZATION_ID,
      name: 'Other folder organization',
      created_by_kilo_user_id: USER_ID,
    },
  ]);
});

beforeEach(async () => {
  const userIds = [USER_ID, OTHER_USER_ID];
  await db
    .delete(cli_sessions_v2)
    .where(
      and(
        inArray(cli_sessions_v2.kilo_user_id, userIds),
        isNotNull(cli_sessions_v2.parent_session_id)
      )
    );
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
    .set({ blocked_reason: null, is_admin: false })
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
  await insertSession({ session_id: SESSION_ID, cloud_agent_session_id: WORKSPACE_ID });
});

describe('workspaceFolders persistence and validation', () => {
  it('lists empty personal and organization scopes', async () => {
    await expect(callerFor().list({ organizationId: null })).resolves.toEqual({ folders: [] });
    await expect(callerFor().list({ organizationId: ORGANIZATION_ID })).resolves.toEqual({
      folders: [],
    });
  });

  it('creates trimmed folders in persistent insertion order and returns only the public contract', async () => {
    const first = await callerFor().create({
      organizationId: null,
      name: '  Release work  ',
      color: 'purple',
    });
    const second = await createFolder(null, 'Release work');
    const third = await createFolder(null, 'Third');

    expect(first).toEqual({
      id: expect.any(String),
      name: 'Release work',
      color: 'purple',
      worktreeIds: [],
    });
    expect(await callerFor().list({ organizationId: null })).toEqual({
      folders: [first, second, third],
    });
    expect((await readFolders()).map(folder => folder.position)).toEqual([0, 1, 2]);
  });

  it.each(workspaceFolderColorSchema.options)('persists palette color %s', async color => {
    const folder = await callerFor().create({ organizationId: null, name: 'Palette', color });
    expect(folder.color).toBe(color);
    expect((await callerFor().list({ organizationId: null })).folders).toEqual([folder]);
  });

  it('updates only supplied fields and preserves order and worktree membership', async () => {
    const first = await callerFor().create({ organizationId: null, name: 'First', color: 'teal' });
    const second = await createFolder(null, 'Second');
    await callerFor().moveWorktree({
      organizationId: null,
      worktreeId: WORKTREE_ID,
      folderId: first.id,
    });
    await callerFor().update({ organizationId: null, folderId: first.id, name: '  Renamed  ' });
    expect((await callerFor().list({ organizationId: null })).folders).toEqual([
      { ...first, name: 'Renamed', worktreeIds: [WORKTREE_ID] },
      second,
    ]);
    await callerFor().update({ organizationId: null, folderId: first.id, color: 'red' });
    expect((await callerFor().list({ organizationId: null })).folders).toEqual([
      { ...first, name: 'Renamed', color: 'red', worktreeIds: [WORKTREE_ID] },
      second,
    ]);
  });

  it.each(['', '  \t\n', 'a'.repeat(201)])(
    'rejects invalid create and update name %p',
    async name => {
      const folder = await createFolder();
      await expect(
        callerFor().create({ organizationId: null, name, color: 'default' })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      await expect(
        callerFor().update({ organizationId: null, folderId: folder.id, name })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect((await callerFor().list({ organizationId: null })).folders).toEqual([folder]);
    }
  );

  it('accepts a 200-character name after trimming', async () => {
    const name = 'a'.repeat(200);
    expect(
      await callerFor().create({ organizationId: null, name: `  ${name}  `, color: 'default' })
    ).toMatchObject({ name });
  });

  it.each(['#ff0000', 'pink', '', 'RED'])('rejects unsupported color %p', async value => {
    const color = value as WorkspaceFolderColor;
    const folder = await createFolder();
    await expect(
      callerFor().create({ organizationId: null, name: 'Invalid', color })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      callerFor().update({ organizationId: null, folderId: folder.id, color })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect((await callerFor().list({ organizationId: null })).folders).toEqual([folder]);
  });

  it('requires an explicit scope on every procedure and a supplied field for updates', async () => {
    const folder = await createFolder();
    const caller = callerFor();
    const moveWithoutScope: Parameters<FolderCaller['moveWorktree']>[0] = {
      organizationId: null,
      worktreeId: WORKTREE_ID,
      folderId: folder.id,
    };
    Reflect.deleteProperty(moveWithoutScope, 'organizationId');
    const requests = [
      () => caller.list({} as Parameters<FolderCaller['list']>[0]),
      () =>
        caller.create({ name: 'Missing scope', color: 'blue' } as Parameters<
          FolderCaller['create']
        >[0]),
      () =>
        caller.update({ folderId: folder.id, name: 'Missing scope' } as Parameters<
          FolderCaller['update']
        >[0]),
      () => caller.delete({ folderId: folder.id } as Parameters<FolderCaller['delete']>[0]),
      () => caller.moveWorktree(moveWithoutScope),
      () => caller.reorder({ folderIds: [folder.id] } as Parameters<FolderCaller['reorder']>[0]),
      () => caller.update({ organizationId: null, folderId: folder.id }),
      () => caller.list({ organizationId: 'not-an-organization' }),
      () => caller.update({ organizationId: null, folderId: 'not-a-folder', name: 'Invalid' }),
      () => caller.delete({ organizationId: null, folderId: 'not-a-folder' }),
      () =>
        caller.moveWorktree({
          organizationId: null,
          worktreeId: WORKTREE_ID,
          folderId: 'not-a-folder',
        }),
      () => caller.reorder({ organizationId: null, folderIds: ['not-a-folder'] }),
    ];
    for (const request of requests) {
      await expect(request()).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
    expect((await caller.list({ organizationId: null })).folders).toEqual([folder]);
    expect(await readWorktree()).toBeUndefined();
  });
});

describe('workspaceFolders authorization', () => {
  it.each([null, ORGANIZATION_ID])('isolates OAuth owners in scope %p', async organizationId => {
    const own = await createFolder(organizationId, 'Mine');
    const other = await createFolder(organizationId, 'Private', otherUser);
    expect((await callerFor().list({ organizationId })).folders).toEqual([own]);
    expect((await callerFor(otherUser).list({ organizationId })).folders).toEqual([other]);
    await expect(
      callerFor().update({ organizationId, folderId: other.id, name: 'Changed' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(callerFor().delete({ organizationId, folderId: other.id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      callerFor().reorder({ organizationId, folderIds: [other.id] })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await callerFor(otherUser).list({ organizationId })).folders).toEqual([other]);
  });

  it.each([
    { organizationId: null, destinationOrganizationId: ORGANIZATION_ID },
    { organizationId: ORGANIZATION_ID, destinationOrganizationId: null },
    { organizationId: ORGANIZATION_ID, destinationOrganizationId: OTHER_ORGANIZATION_ID },
  ])(
    'rejects cross-scope destinations and folder edits: %p',
    async ({ organizationId, destinationOrganizationId }) => {
      const destination = await createFolder(destinationOrganizationId);
      const worktreeId = newWorktreeId();
      await insertSession({ organization_id: organizationId, cloud_agent_worktree_id: worktreeId });
      const caller = callerFor();
      await expect(
        caller.update({ organizationId, folderId: destination.id, name: 'Wrong scope' })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        caller.delete({ organizationId, folderId: destination.id })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        caller.reorder({ organizationId, folderIds: [destination.id] })
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      await expect(
        caller.moveWorktree({ organizationId, worktreeId, folderId: destination.id })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(await readWorktree(worktreeId)).toBeUndefined();
      expect((await caller.list({ organizationId: destinationOrganizationId })).folders).toEqual([
        destination,
      ]);
    }
  );

  it('rejects a destination owned by another member of the same organization', async () => {
    const destination = await createFolder(ORGANIZATION_ID, 'Other layout', otherUser);
    const worktreeId = newWorktreeId();
    await insertSession({ organization_id: ORGANIZATION_ID, cloud_agent_worktree_id: worktreeId });
    await expect(
      callerFor().moveWorktree({
        organizationId: ORGANIZATION_ID,
        worktreeId,
        folderId: destination.id,
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await readWorktree(worktreeId)).toBeUndefined();
  });

  it.each([
    { sourceUserId: OTHER_USER_ID, sourceOrganizationId: null, organizationId: null },
    {
      sourceUserId: OTHER_USER_ID,
      sourceOrganizationId: ORGANIZATION_ID,
      organizationId: ORGANIZATION_ID,
    },
    { sourceUserId: USER_ID, sourceOrganizationId: ORGANIZATION_ID, organizationId: null },
    { sourceUserId: USER_ID, sourceOrganizationId: null, organizationId: ORGANIZATION_ID },
    {
      sourceUserId: USER_ID,
      sourceOrganizationId: OTHER_ORGANIZATION_ID,
      organizationId: ORGANIZATION_ID,
    },
  ])(
    'rejects cross-owner or cross-scope sources with or without metadata: %p',
    async ({ sourceUserId, sourceOrganizationId, organizationId }) => {
      const destination = await createFolder(organizationId);
      for (const hasMetadata of [false, true]) {
        const worktreeId = newWorktreeId();
        await insertSession({
          kilo_user_id: sourceUserId,
          organization_id: sourceOrganizationId,
          cloud_agent_worktree_id: worktreeId,
        });
        if (hasMetadata) {
          await insertWorktree({
            worktree_id: worktreeId,
            kilo_user_id: sourceUserId,
            organization_id: sourceOrganizationId,
          });
        }
        for (const folderId of [destination.id, null]) {
          await expect(
            callerFor().moveWorktree({ organizationId, worktreeId, folderId })
          ).rejects.toMatchObject({ code: 'NOT_FOUND' });
        }
        if (hasMetadata) {
          expect(await readWorktree(worktreeId)).toMatchObject({
            kilo_user_id: sourceUserId,
            organization_id: sourceOrganizationId,
            folder_id: null,
          });
        } else {
          expect(await readWorktree(worktreeId)).toBeUndefined();
        }
      }
    }
  );

  it.each([false, true])(
    'rechecks current membership for every procedure with a stale admin=%p context',
    async isAdmin => {
      await db
        .update(kilocode_users)
        .set({ is_admin: isAdmin })
        .where(eq(kilocode_users.id, USER_ID));
      const caller = callerFor({ ...user, is_admin: isAdmin });
      const folder = await caller.create({
        organizationId: ORGANIZATION_ID,
        name: 'Retained private layout',
        color: 'green',
      });
      const worktreeId = newWorktreeId();
      await insertSession({
        organization_id: ORGANIZATION_ID,
        cloud_agent_worktree_id: worktreeId,
      });
      await caller.moveWorktree({
        organizationId: ORGANIZATION_ID,
        worktreeId,
        folderId: folder.id,
      });
      const storedFolders = await readFolders(ORGANIZATION_ID);
      const worktree = await readWorktree(worktreeId);
      await db
        .delete(organization_memberships)
        .where(
          and(
            eq(organization_memberships.kilo_user_id, USER_ID),
            eq(organization_memberships.organization_id, ORGANIZATION_ID)
          )
        );
      const requests = [
        () => caller.list({ organizationId: ORGANIZATION_ID }),
        () => caller.create({ organizationId: ORGANIZATION_ID, name: 'Forbidden', color: 'blue' }),
        () =>
          caller.update({
            organizationId: ORGANIZATION_ID,
            folderId: folder.id,
            name: 'Forbidden',
          }),
        () => caller.delete({ organizationId: ORGANIZATION_ID, folderId: folder.id }),
        () => caller.moveWorktree({ organizationId: ORGANIZATION_ID, worktreeId, folderId: null }),
        () => caller.reorder({ organizationId: ORGANIZATION_ID, folderIds: [folder.id] }),
      ];
      for (const request of requests) {
        await expect(request()).rejects.toMatchObject({ code: 'FORBIDDEN' });
      }
      expect(await readFolders(ORGANIZATION_ID)).toEqual(storedFolders);
      expect(await readWorktree(worktreeId)).toEqual(worktree);
      await expect(caller.list({ organizationId: null })).resolves.toEqual({ folders: [] });
    }
  );

  it('does not grant access to a deleted organization with a retained membership', async () => {
    await createFolder(ORGANIZATION_ID);
    await db
      .update(organizations)
      .set({ deleted_at: LATER_TIME })
      .where(eq(organizations.id, ORGANIZATION_ID));
    await expect(callerFor().list({ organizationId: ORGANIZATION_ID })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(createFolder(ORGANIZATION_ID)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it.each([createDeletionInProgressBlockedReason(), createSoftDeletedBlockedReason()])(
    'does not recreate private metadata through a stale deleted-user context: %s',
    async blockedReason => {
      const caller = callerFor();
      await db
        .update(kilocode_users)
        .set({ blocked_reason: blockedReason })
        .where(eq(kilocode_users.id, USER_ID));
      await expect(
        caller.create({ organizationId: null, name: 'Should not persist', color: 'default' })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        caller.moveWorktree({ organizationId: null, worktreeId: WORKTREE_ID, folderId: null })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(await readFolders()).toEqual([]);
      expect(await readWorktree()).toBeUndefined();
    }
  );
});

describe('workspaceFolders worktree membership', () => {
  it('moves all sibling chats into, between, and out of folders without changing chat activity or runtime metadata', async () => {
    const first = await createFolder(null, 'First');
    const second = await createFolder(null, 'Second');
    await insertSession({
      status: 'busy',
      status_updated_at: LATER_TIME,
      last_activity_at: LATER_TIME,
    });
    await insertSession({
      parent_session_id: SESSION_ID,
      cloud_agent_session_id: null,
      cloud_agent_session_scope_id: WORKSPACE_ID,
    });
    await insertWorktree({
      name: 'Workspace name',
      runtime_locations: [{ sandboxId: 'workspace-folder-sandbox', provider: 'cloudflare' }],
    });
    const sessions = await readSessions();
    const worktree = await readWorktree();
    const caller = callerFor();
    for (const folderId of [first.id, second.id, null]) {
      await caller.moveWorktree({ organizationId: null, worktreeId: WORKTREE_ID, folderId });
      expect((await caller.list({ organizationId: null })).folders).toEqual([
        { ...first, worktreeIds: folderId === first.id ? [WORKTREE_ID] : [] },
        { ...second, worktreeIds: folderId === second.id ? [WORKTREE_ID] : [] },
      ]);
      expect(await readSessions()).toEqual(sessions);
      expect(await readWorktree()).toMatchObject({
        name: worktree?.name,
        runtime_locations: worktree?.runtime_locations,
        folder_id: folderId,
        deletion_started_at: null,
        deletion_completed_at: null,
      });
    }
  });

  it('lazily materializes metadata for older owned control-plane groups', async () => {
    const folder = await createFolder();
    await db
      .update(cli_sessions_v2)
      .set({ created_at: '2020-01-01T00:00:00.000Z', updated_at: '2020-01-01T00:00:00.000Z' })
      .where(eq(cli_sessions_v2.session_id, SESSION_ID));
    await insertSession();
    const sessions = await readSessions();
    expect(await readWorktree()).toBeUndefined();
    await callerFor().moveWorktree({
      organizationId: null,
      worktreeId: WORKTREE_ID,
      folderId: folder.id,
    });
    const worktree = await readWorktree();
    expect(worktree).toMatchObject({
      kilo_user_id: USER_ID,
      organization_id: null,
      folder_id: folder.id,
      name: null,
    });
    expect(new Date(worktree?.created_at ?? '').toISOString()).toBe('2020-01-01T00:00:00.000Z');
    expect(await readSessions()).toEqual(sessions);
  });

  it('keeps complete membership beyond recent-session and search-page limits', async () => {
    const folder = await createFolder();
    const worktreeIds = Array.from({ length: 205 }, newWorktreeId);
    await db.insert(cloud_agent_worktrees).values(
      worktreeIds.map(worktreeId => ({
        worktree_id: worktreeId,
        kilo_user_id: USER_ID,
        folder_id: folder.id,
      }))
    );
    await db.insert(cli_sessions_v2).values(
      worktreeIds.map(worktreeId =>
        makeSession({
          cloud_agent_worktree_id: worktreeId,
          title: 'Outside the current search',
          created_on_platform: 'cli',
          created_at: '2020-01-01T00:00:00.000Z',
          updated_at: '2020-01-01T00:00:00.000Z',
        })
      )
    );
    await insertSession();
    await callerFor().moveWorktree({
      organizationId: null,
      worktreeId: WORKTREE_ID,
      folderId: folder.id,
    });
    expect((await callerFor().list({ organizationId: null })).folders).toEqual([
      { ...folder, worktreeIds: [...worktreeIds, WORKTREE_ID].sort() },
    ]);
  });

  it.each([null, 'agent_legacy', 'workspace_invalid', `${WORKSPACE_ID}/extra`, SESSION_ID])(
    'rejects non-control-plane root reference %p even when metadata exists',
    async cloudAgentSessionId => {
      const folder = await createFolder();
      await db
        .update(cli_sessions_v2)
        .set({ cloud_agent_session_id: cloudAgentSessionId })
        .where(eq(cli_sessions_v2.session_id, SESSION_ID));
      await insertWorktree();
      for (const folderId of [folder.id, null]) {
        await expect(
          callerFor().moveWorktree({ organizationId: null, worktreeId: WORKTREE_ID, folderId })
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      }
      expect((await readWorktree())?.folder_id).toBeNull();
    }
  );

  it.each(['worktree_invalid', 'worktree_../../private', WORKSPACE_ID])(
    'rejects malformed worktree ID %s before materializing metadata',
    async value => {
      await expect(
        callerFor().moveWorktree({
          organizationId: null,
          worktreeId: value as CloudAgentWorktreeId,
          folderId: null,
        })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(await readWorktree()).toBeUndefined();
    }
  );

  it('requires surviving owned roots rather than metadata or child ownership alone', async () => {
    const folder = await createFolder();
    const emptyWorktreeId = newWorktreeId();
    const childOnlyWorktreeId = newWorktreeId();
    await insertWorktree({ worktree_id: emptyWorktreeId });
    await insertWorktree({ worktree_id: childOnlyWorktreeId });
    await insertSession({
      cloud_agent_worktree_id: childOnlyWorktreeId,
      parent_session_id: SESSION_ID,
    });
    for (const worktreeId of [emptyWorktreeId, childOnlyWorktreeId, newWorktreeId()]) {
      await expect(
        callerFor().moveWorktree({ organizationId: null, worktreeId, folderId: folder.id })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }
  });

  it('does not trust matching root ownership when metadata belongs to another owner or scope', async () => {
    const folder = await createFolder();
    for (const overrides of [
      { kilo_user_id: OTHER_USER_ID },
      { organization_id: ORGANIZATION_ID },
    ]) {
      const worktreeId = newWorktreeId();
      await insertSession({ cloud_agent_worktree_id: worktreeId });
      await insertWorktree({ worktree_id: worktreeId, ...overrides });
      await expect(
        callerFor().moveWorktree({ organizationId: null, worktreeId, folderId: folder.id })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect((await readWorktree(worktreeId))?.folder_id).toBeNull();
    }
  });

  it('hides inaccessible, invalid, child-only, rootless, and deleting groups without pruning stored membership', async () => {
    const folder = await createFolder();
    await callerFor().moveWorktree({
      organizationId: null,
      worktreeId: WORKTREE_ID,
      folderId: folder.id,
    });
    await insertSession();
    const hidden = [
      { metadata: { kilo_user_id: OTHER_USER_ID }, session: { kilo_user_id: OTHER_USER_ID } },
      {
        metadata: { organization_id: ORGANIZATION_ID },
        session: { organization_id: ORGANIZATION_ID },
      },
      { metadata: {}, session: { kilo_user_id: OTHER_USER_ID } },
      { metadata: {}, session: { organization_id: ORGANIZATION_ID } },
      { metadata: {}, session: { parent_session_id: SESSION_ID } },
      { metadata: {}, session: { cloud_agent_session_id: 'agent_hidden_legacy' } },
      { metadata: { deletion_started_at: INITIAL_TIME }, session: {} },
      {
        metadata: { deletion_started_at: INITIAL_TIME, deletion_completed_at: LATER_TIME },
        session: {},
      },
    ] satisfies { metadata: Partial<WorktreeInsert>; session: Partial<NewCliSessionV2> }[];
    for (const item of hidden) {
      const worktreeId = newWorktreeId();
      await insertWorktree({ worktree_id: worktreeId, folder_id: folder.id, ...item.metadata });
      await insertSession({ cloud_agent_worktree_id: worktreeId, ...item.session });
    }
    await insertWorktree({ worktree_id: newWorktreeId(), folder_id: folder.id });
    await insertWorktree({ worktree_id: 'worktree_invalid', folder_id: folder.id });
    await insertSession({ cloud_agent_worktree_id: 'worktree_invalid' });
    const stored = await db
      .select()
      .from(cloud_agent_worktrees)
      .where(eq(cloud_agent_worktrees.folder_id, folder.id));
    expect((await callerFor().list({ organizationId: null })).folders).toEqual([
      { ...folder, worktreeIds: [WORKTREE_ID] },
    ]);
    expect(
      await db
        .select()
        .from(cloud_agent_worktrees)
        .where(eq(cloud_agent_worktrees.folder_id, folder.id))
    ).toEqual(stored);
  });

  it.each([false, true])('rejects moves on deletion fences with completed=%p', async completed => {
    const folder = await createFolder();
    await insertWorktree({
      deletion_started_at: INITIAL_TIME,
      deletion_completed_at: completed ? LATER_TIME : null,
    });
    for (const folderId of [folder.id, null]) {
      await expect(
        callerFor().moveWorktree({ organizationId: null, worktreeId: WORKTREE_ID, folderId })
      ).rejects.toMatchObject({ code: 'CONFLICT' });
    }
    expect((await readWorktree())?.folder_id).toBeNull();
    expect(await readSessions()).toHaveLength(1);
  });

  it('honors a deletion fence committed by an overlapping worktree writer', async () => {
    const folder = await createFolder();
    await insertWorktree();
    const locked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const deletion = db.transaction(async tx => {
      await tx
        .update(cloud_agent_worktrees)
        .set({ deletion_started_at: INITIAL_TIME })
        .where(eq(cloud_agent_worktrees.worktree_id, WORKTREE_ID));
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    const move = expect(
      callerFor().moveWorktree({
        organizationId: null,
        worktreeId: WORKTREE_ID,
        folderId: folder.id,
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    release.resolve();
    await Promise.all([deletion, move]);
    expect((await readWorktree())?.folder_id).toBeNull();
  });

  it('deletes a folder by unfiling worktrees while preserving workspaces, chats, and other folders', async () => {
    const folder = await createFolder();
    const otherFolder = await createFolder(null, 'Keep');
    await insertSession({ status: 'busy' });
    await insertSession({ parent_session_id: SESSION_ID, cloud_agent_session_id: null });
    await insertWorktree({
      name: 'Keep workspace',
      runtime_locations: [{ sandboxId: 'folder-delete-sandbox', provider: 'cloudflare' }],
    });
    await callerFor().moveWorktree({
      organizationId: null,
      worktreeId: WORKTREE_ID,
      folderId: folder.id,
    });
    const worktree = await readWorktree();
    const sessions = await readSessions();
    await callerFor().delete({ organizationId: null, folderId: folder.id });
    expect(await readWorktree()).toEqual({ ...worktree, folder_id: null });
    expect(await readSessions()).toEqual(sessions);
    expect((await callerFor().list({ organizationId: null })).folders).toEqual([otherFolder]);
  });
});

describe('workspaceFolders authoritative ordering', () => {
  it('accepts only a unique, complete order and preserves all folders on rejection', async () => {
    const first = await createFolder(null, 'First');
    const second = await createFolder(null, 'Second');
    const third = await createFolder(null, 'Third');
    const caller = callerFor();
    const before = await readFolders();
    for (const folderIds of [
      [],
      [first.id, second.id],
      [first.id, second.id, crypto.randomUUID()],
    ]) {
      await expect(caller.reorder({ organizationId: null, folderIds })).rejects.toMatchObject({
        code: 'CONFLICT',
      });
      expect(await readFolders()).toEqual(before);
    }
    await expect(
      caller.reorder({ organizationId: null, folderIds: [first.id, first.id, second.id] })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller.reorder({
        organizationId: null,
        folderIds: [first.id, first.id.toUpperCase(), second.id],
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await caller.reorder({
      organizationId: null,
      folderIds: [third.id.toUpperCase(), first.id, second.id],
    });
    expect((await caller.list({ organizationId: null })).folders).toEqual([third, first, second]);
    expect((await readFolders()).map(folder => folder.position)).toEqual([0, 1, 2]);
  });

  it('rejects stale orders after creation or deletion without dropping newly created folders', async () => {
    const first = await createFolder(null, 'First');
    const second = await createFolder(null, 'Second');
    const third = await createFolder(null, 'New');
    const caller = callerFor();
    await expect(
      caller.reorder({ organizationId: null, folderIds: [second.id, first.id] })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await caller.list({ organizationId: null })).folders).toEqual([first, second, third]);
    await caller.delete({ organizationId: null, folderId: second.id });
    await expect(
      caller.reorder({ organizationId: null, folderIds: [third.id, second.id, first.id] })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await caller.list({ organizationId: null })).folders).toEqual([first, third]);
  });

  it('assigns distinct persistent positions to concurrent creates', async () => {
    const created = await Promise.all(
      Array.from({ length: 8 }, (_, index) => createFolder(null, `Concurrent ${index}`))
    );
    const rows = await readFolders();
    expect(rows.map(folder => folder.position)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(new Set(rows.map(folder => folder.id))).toEqual(
      new Set(created.map(folder => folder.id))
    );
    expect(
      (await callerFor().list({ organizationId: null })).folders.map(folder => folder.id)
    ).toEqual(rows.map(folder => folder.id));
  });

  it('serializes create against an authoritative reorder', async () => {
    const first = await createFolder(null, 'First');
    const second = await createFolder(null, 'Second');
    const caller = callerFor();
    const [reordered, created] = await Promise.allSettled([
      caller.reorder({ organizationId: null, folderIds: [second.id, first.id] }),
      createFolder(null, 'Concurrent'),
    ]);
    if (created.status !== 'fulfilled') throw created.reason;
    if (reordered.status === 'rejected')
      expect(reordered.reason).toMatchObject({ code: 'CONFLICT' });
    expect((await caller.list({ organizationId: null })).folders).toEqual([
      ...(reordered.status === 'fulfilled' ? [second, first] : [first, second]),
      created.value,
    ]);
    expect((await readFolders()).map(folder => folder.position)).toEqual([0, 1, 2]);
  });

  it('serializes deletion against an authoritative reorder', async () => {
    const first = await createFolder(null, 'First');
    const second = await createFolder(null, 'Second');
    const third = await createFolder(null, 'Third');
    const caller = callerFor();
    const [reordered, deleted] = await Promise.allSettled([
      caller.reorder({ organizationId: null, folderIds: [third.id, second.id, first.id] }),
      caller.delete({ organizationId: null, folderId: second.id }),
    ]);
    expect(deleted.status).toBe('fulfilled');
    if (reordered.status === 'rejected')
      expect(reordered.reason).toMatchObject({ code: 'CONFLICT' });
    expect((await caller.list({ organizationId: null })).folders).toEqual(
      reordered.status === 'fulfilled' ? [third, first] : [first, third]
    );
  });

  it('uses a deterministic ID tie-breaker for existing equal positions and permits an empty scope order', async () => {
    await callerFor().reorder({ organizationId: null, folderIds: [] });
    const first = await createFolder(null, 'First');
    const second = await createFolder(null, 'Second');
    await db
      .update(cloud_agent_workspace_folders)
      .set({ position: 0 })
      .where(eq(cloud_agent_workspace_folders.kilo_user_id, USER_ID));
    expect((await callerFor().list({ organizationId: null })).folders).toEqual(
      [first, second].sort((a, b) => a.id.localeCompare(b.id))
    );
  });
});
