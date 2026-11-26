import { describe, test, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { randomUUID } from 'crypto';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { code_indexing_manifest, kilocode_users } from '@kilocode/db/schema';
import { eq, inArray } from 'drizzle-orm';
import type { Organization, User } from '@kilocode/db/schema';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { addUserToOrganization } from '@kilocode/web-shared/lib/organizations/organizations';
import {
  setAdminAccessSinkForTest,
  type AdminAccessEvent,
} from '@kilocode/web-shared/lib/admin/admin-access-log';
import { createCallerForUser, createSessionCallerForUser } from '@/routers/test-utils';
import {
  ALLOWED_ADMIN_ADDRESS,
  OFF_NETWORK_ADDRESS,
  withEnforcedAdminNetwork,
} from '@/tests/helpers/admin-network.helper';

/** The one account the configured list enables; see the config mock below. */
const ALLOWLISTED_USER_ID = '0b6f5c1e-7d1a-4c55-9a43-2f1b2b6d9e01';

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  ...jest.requireActual<Record<string, unknown>>('@kilocode/web-shared/lib/config.server'),
  CODE_INDEXING_ENABLED_USER_IDS: '0b6f5c1e-7d1a-4c55-9a43-2f1b2b6d9e01',
}));

jest.mock('@/lib/code-indexing/availability.server', () => ({
  CODE_INDEXING_GONE_MESSAGE: 'Managed code indexing is no longer available.',
  isCodeIndexingEnabled: () => true,
}));

type MilvusDelete = { collection_name: string; filter: string };

jest.mock('@/lib/code-indexing/milvus', () => {
  const deletes: MilvusDelete[] = [];
  return {
    getMilvusClient: () => ({
      delete: async (params: MilvusDelete) => {
        deletes.push(params);
      },
    }),
    __milvusDeletes: deletes,
  };
});

const milvusDeletes = () =>
  jest.requireMock<{ __milvusDeletes: MilvusDelete[] }>('@/lib/code-indexing/milvus')
    .__milvusDeletes;

const CUTOFF = new Date('2026-01-01T00:00:00.000Z');
const OLD = '2025-12-01T00:00:00.000Z';
const RECENT = '2026-06-01T00:00:00.000Z';

async function insertManifestRow(input: {
  organizationId: string;
  kiloUserId?: string;
  projectId: string;
  filePath: string;
  createdAt: string;
}) {
  await db.insert(code_indexing_manifest).values({
    organization_id: input.organizationId,
    kilo_user_id: input.kiloUserId ?? null,
    project_id: input.projectId,
    git_branch: 'main',
    file_hash: randomUUID(),
    file_path: input.filePath,
    chunk_count: 3,
    created_at: input.createdAt,
  });
}

async function manifestFiles(organizationId: string): Promise<string[]> {
  const rows = await db
    .select({ filePath: code_indexing_manifest.file_path })
    .from(code_indexing_manifest)
    .where(eq(code_indexing_manifest.organization_id, organizationId));
  return rows.map(row => row.filePath).sort();
}

describe('codeIndexing.deleteBeforeDate authorization', () => {
  let owner: User;
  let member: User;
  let admin: User;
  let organization: Organization;
  let otherOrganization: Organization;

  beforeAll(async () => {
    const suffix = randomUUID().slice(0, 8);
    owner = await insertTestUser({
      id: randomUUID(),
      google_user_email: `code-index-owner-${suffix}@example.com`,
    });
    member = await insertTestUser({
      id: randomUUID(),
      google_user_email: `code-index-member-${suffix}@example.com`,
    });
    admin = await insertTestUser({
      id: randomUUID(),
      google_user_email: `code-index-admin-${suffix}@example.com`,
      is_admin: true,
    });

    organization = await createTestOrganization(`Code Index Org ${suffix}`, owner.id, 0);
    otherOrganization = await createTestOrganization(`Code Index Other ${suffix}`, owner.id, 0);
    await addUserToOrganization(organization.id, member.id, 'member');
  });

  beforeEach(async () => {
    milvusDeletes().length = 0;
    await db
      .delete(code_indexing_manifest)
      .where(
        inArray(code_indexing_manifest.organization_id, [
          organization.id,
          otherOrganization.id,
          owner.id,
          member.id,
          admin.id,
        ])
      );
  });

  afterAll(async () => {
    await db
      .delete(code_indexing_manifest)
      .where(
        inArray(code_indexing_manifest.organization_id, [
          organization.id,
          otherOrganization.id,
          owner.id,
          member.id,
          admin.id,
        ])
      );
  });

  test('refuses an ordinary organization member and leaves the index intact', async () => {
    await insertManifestRow({
      organizationId: organization.id,
      kiloUserId: owner.id,
      projectId: 'acme/app',
      filePath: 'src/old.ts',
      createdAt: OLD,
    });

    const caller = await createCallerForUser(member.id);

    await expect(
      caller.codeIndexing.deleteBeforeDate({ organizationId: organization.id, beforeDate: CUTOFF })
    ).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'You do not have the required organizational role to access this feature',
    });

    expect(await manifestFiles(organization.id)).toEqual(['src/old.ts']);
    expect(milvusDeletes()).toHaveLength(0);
  });

  test('lets an organization owner purge the organization index', async () => {
    await insertManifestRow({
      organizationId: organization.id,
      kiloUserId: owner.id,
      projectId: 'acme/app',
      filePath: 'src/old.ts',
      createdAt: OLD,
    });
    await insertManifestRow({
      organizationId: organization.id,
      kiloUserId: owner.id,
      projectId: 'acme/app',
      filePath: 'src/recent.ts',
      createdAt: RECENT,
    });
    await insertManifestRow({
      organizationId: otherOrganization.id,
      kiloUserId: owner.id,
      projectId: 'acme/other',
      filePath: 'src/elsewhere.ts',
      createdAt: OLD,
    });

    const caller = await createCallerForUser(owner.id);

    await expect(
      caller.codeIndexing.deleteBeforeDate({ organizationId: organization.id, beforeDate: CUTOFF })
    ).resolves.toEqual({ success: true });

    expect(await manifestFiles(organization.id)).toEqual(['src/recent.ts']);
    expect(await manifestFiles(otherOrganization.id)).toEqual(['src/elsewhere.ts']);
    expect(milvusDeletes()).toEqual([
      {
        collection_name: 'org_code_indexing',
        filter: `organization_id == "${organization.id}" && created_at < ${CUTOFF.getTime()}`,
      },
    ]);
  });

  test('lets a Kilo administrator purge an organization index without a membership', async () => {
    await insertManifestRow({
      organizationId: organization.id,
      kiloUserId: owner.id,
      projectId: 'acme/app',
      filePath: 'src/old.ts',
      createdAt: OLD,
    });

    await withEnforcedAdminNetwork(async () => {
      const caller = await createSessionCallerForUser(admin.id, { headers: ALLOWED_ADMIN_ADDRESS });

      await expect(
        caller.codeIndexing.deleteBeforeDate({
          organizationId: organization.id,
          beforeDate: CUTOFF,
        })
      ).resolves.toEqual({ success: true });
    });

    expect(await manifestFiles(organization.id)).toEqual([]);
  });

  test('keeps personal cleanup available to an admitted staff browser session', async () => {
    await insertManifestRow({
      organizationId: admin.id,
      kiloUserId: admin.id,
      projectId: 'me/local',
      filePath: 'src/old.ts',
      createdAt: OLD,
    });
    await insertManifestRow({
      organizationId: organization.id,
      kiloUserId: owner.id,
      projectId: 'acme/app',
      filePath: 'src/org.ts',
      createdAt: OLD,
    });

    await withEnforcedAdminNetwork(async () => {
      const caller = await createSessionCallerForUser(admin.id, { headers: ALLOWED_ADMIN_ADDRESS });

      await expect(caller.codeIndexing.deleteBeforeDate({ beforeDate: CUTOFF })).resolves.toEqual({
        success: true,
      });
    });

    expect(await manifestFiles(admin.id)).toEqual([]);
    expect(await manifestFiles(organization.id)).toEqual(['src/org.ts']);
  });

  test('gives a staff bearer caller the ordinary personal refusal', async () => {
    await insertManifestRow({
      organizationId: admin.id,
      kiloUserId: admin.id,
      projectId: 'me/local',
      filePath: 'src/old.ts',
      createdAt: OLD,
    });

    const caller = await createCallerForUser(admin.id);

    await expect(
      caller.codeIndexing.deleteBeforeDate({ beforeDate: CUTOFF })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Code indexing is not enabled for this account',
    });
    expect(await manifestFiles(admin.id)).toEqual(['src/old.ts']);
    expect(milvusDeletes()).toHaveLength(0);
  });

  test('refuses an off-network staff browser session before any personal index change', async () => {
    await insertManifestRow({
      organizationId: admin.id,
      kiloUserId: admin.id,
      projectId: 'me/local',
      filePath: 'src/old.ts',
      createdAt: OLD,
    });

    await withEnforcedAdminNetwork(async () => {
      const caller = await createSessionCallerForUser(admin.id, { headers: OFF_NETWORK_ADDRESS });
      const refusal = { code: 'FORBIDDEN', message: expect.stringContaining('Cloudflare WARP') };

      await expect(
        caller.codeIndexing.deleteBeforeDate({ beforeDate: CUTOFF })
      ).rejects.toMatchObject(refusal);
      // The per-file delete turns ordinary failures into `{ success: false }`,
      // but passes the typed staff refusal through.
      await expect(
        caller.codeIndexing.delete({ projectId: 'me/local', filePaths: ['src/old.ts'] })
      ).rejects.toMatchObject(refusal);
    });

    expect(await manifestFiles(admin.id)).toEqual(['src/old.ts']);
    expect(milvusDeletes()).toHaveLength(0);
  });

  test('keeps the configured list working for a bearer caller without staff authority', async () => {
    await insertTestUser({
      id: ALLOWLISTED_USER_ID,
      google_user_email: `code-index-allowlisted-${randomUUID().slice(0, 8)}@example.com`,
    });
    await insertManifestRow({
      organizationId: ALLOWLISTED_USER_ID,
      kiloUserId: ALLOWLISTED_USER_ID,
      projectId: 'me/local',
      filePath: 'src/old.ts',
      createdAt: OLD,
    });

    try {
      await withEnforcedAdminNetwork(async () => {
        const caller = await createCallerForUser(ALLOWLISTED_USER_ID, {
          headers: OFF_NETWORK_ADDRESS,
        });
        await expect(caller.codeIndexing.deleteBeforeDate({ beforeDate: CUTOFF })).resolves.toEqual(
          { success: true }
        );
      });
      expect(await manifestFiles(ALLOWLISTED_USER_ID)).toEqual([]);
    } finally {
      await db.delete(kilocode_users).where(eq(kilocode_users.id, ALLOWLISTED_USER_ID));
    }
  });

  test('refuses the personal scope for an account without the entitlement', async () => {
    await insertManifestRow({
      organizationId: member.id,
      kiloUserId: member.id,
      projectId: 'me/local',
      filePath: 'src/old.ts',
      createdAt: OLD,
    });

    const caller = await createCallerForUser(member.id);

    await expect(
      caller.codeIndexing.deleteBeforeDate({ beforeDate: CUTOFF })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Code indexing is not enabled for this account',
    });
    await expect(
      caller.codeIndexing.search({
        query: 'where is the retry helper',
        projectId: 'me/local',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(await manifestFiles(member.id)).toEqual(['src/old.ts']);
    expect(milvusDeletes()).toHaveLength(0);
  });

  test('keeps per-file deletes available to organization members', async () => {
    await insertManifestRow({
      organizationId: organization.id,
      kiloUserId: owner.id,
      projectId: 'acme/app',
      filePath: 'src/old.ts',
      createdAt: OLD,
    });

    const caller = await createCallerForUser(member.id);

    await expect(
      caller.codeIndexing.delete({
        organizationId: organization.id,
        projectId: 'acme/app',
        filePaths: ['src/old.ts'],
      })
    ).resolves.toEqual({ success: true, deletedFiles: 1 });

    expect(await manifestFiles(organization.id)).toEqual([]);
  });
});

describe('codeIndexing overrideUser staff reads', () => {
  let owner: User;
  let member: User;
  let admin: User;
  let organization: Organization;

  beforeAll(async () => {
    const suffix = randomUUID().slice(0, 8);
    owner = await insertTestUser({
      id: randomUUID(),
      google_user_email: `code-index-override-owner-${suffix}@example.com`,
    });
    member = await insertTestUser({
      id: randomUUID(),
      google_user_email: `code-index-override-member-${suffix}@example.com`,
    });
    admin = await insertTestUser({
      id: randomUUID(),
      google_user_email: `code-index-override-admin-${suffix}@example.com`,
      is_admin: true,
    });
    organization = await createTestOrganization(`Code Index Override ${suffix}`, owner.id, 0);
    await insertManifestRow({
      organizationId: organization.id,
      kiloUserId: owner.id,
      projectId: 'acme/app',
      filePath: 'src/org.ts',
      createdAt: RECENT,
    });
    await insertManifestRow({
      organizationId: member.id,
      kiloUserId: member.id,
      projectId: 'me/local',
      filePath: 'src/personal.ts',
      createdAt: RECENT,
    });
  });

  afterAll(async () => {
    await db
      .delete(code_indexing_manifest)
      .where(inArray(code_indexing_manifest.organization_id, [organization.id, member.id]));
  });

  test('refuses a caller without the platform admin flag', async () => {
    const caller = await createSessionCallerForUser(member.id);

    await expect(
      caller.codeIndexing.getOrganizationStats({ overrideUser: organization.id })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Only admins can use overrideUser parameter',
    });
  });

  test('refuses a staff bearer caller with the typed browser-session refusal', async () => {
    const caller = await createCallerForUser(admin.id);

    await expect(
      caller.codeIndexing.getOrganizationStats({ overrideUser: organization.id })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      cause: expect.objectContaining({ code: 'BEARER_NOT_ALLOWED', actionClass: 'support_read' }),
    });
  });

  test('refuses an off-network staff session before any override lookup or record', async () => {
    const events: AdminAccessEvent[] = [];
    setAdminAccessSinkForTest(event => events.push(event));
    try {
      await withEnforcedAdminNetwork(async () => {
        const caller = await createSessionCallerForUser(admin.id, { headers: OFF_NETWORK_ADDRESS });
        const refusal = { code: 'FORBIDDEN', message: expect.stringContaining('Cloudflare WARP') };

        await expect(
          caller.codeIndexing.getOrganizationStats({ overrideUser: organization.id })
        ).rejects.toMatchObject(refusal);
        await expect(
          caller.codeIndexing.getOrganizationStats({ overrideUser: 'nobody@example.com' })
        ).rejects.toMatchObject(refusal);
        await expect(
          caller.codeIndexing.getOrganizationStats({ overrideUser: randomUUID() })
        ).rejects.toMatchObject(refusal);
      });
    } finally {
      setAdminAccessSinkForTest(null);
    }
    expect(events.filter(event => event.kind === 'kilo_admin_elevation')).toEqual([]);
  });

  test('reads the named index for an admitted staff session and records its target', async () => {
    const events: AdminAccessEvent[] = [];
    setAdminAccessSinkForTest(event => events.push(event));
    try {
      await withEnforcedAdminNetwork(async () => {
        const caller = await createSessionCallerForUser(admin.id, {
          headers: ALLOWED_ADMIN_ADDRESS,
        });

        const organizationStats = await caller.codeIndexing.getOrganizationStats({
          overrideUser: organization.id,
        });
        expect(organizationStats.map(project => project.project_id)).toEqual(['acme/app']);

        const userStats = await caller.codeIndexing.getOrganizationStats({
          overrideUser: member.google_user_email,
        });
        expect(userStats.map(project => project.project_id)).toEqual(['me/local']);

        // A UUID names the index namespace as given, as before.
        const files = await caller.codeIndexing.getProjectFiles({
          overrideUser: member.id,
          projectId: 'me/local',
        });
        expect(files.files.map(file => file.file_path)).toEqual(['src/personal.ts']);

        await expect(
          caller.codeIndexing.getOrganizationStats({ overrideUser: 'nobody@example.com' })
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      });
    } finally {
      setAdminAccessSinkForTest(null);
    }
    expect(
      events.flatMap(event =>
        event.kind === 'kilo_admin_elevation' ? [[event.reason, event.target]] : []
      )
    ).toEqual([
      ['code_index_user_override', `organization:${organization.id}`],
      ['code_index_user_override', `user:${member.id}`],
      ['code_index_user_override', `user:${member.id}`],
    ]);
  });
});
