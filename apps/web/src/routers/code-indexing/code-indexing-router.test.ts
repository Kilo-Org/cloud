import { describe, test, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { randomUUID } from 'crypto';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { code_indexing_manifest } from '@kilocode/db/schema';
import { eq, inArray } from 'drizzle-orm';
import type { Organization, User } from '@kilocode/db/schema';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { addUserToOrganization } from '@kilocode/web-shared/lib/organizations/organizations';
import { createCallerForUser } from '@/routers/test-utils';

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

    const caller = await createCallerForUser(admin.id);

    await expect(
      caller.codeIndexing.deleteBeforeDate({ organizationId: organization.id, beforeDate: CUTOFF })
    ).resolves.toEqual({ success: true });

    expect(await manifestFiles(organization.id)).toEqual([]);
  });

  test('keeps personal cleanup available without an organization', async () => {
    await insertManifestRow({
      organizationId: member.id,
      kiloUserId: member.id,
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

    const caller = await createCallerForUser(member.id);

    await expect(caller.codeIndexing.deleteBeforeDate({ beforeDate: CUTOFF })).resolves.toEqual({
      success: true,
    });

    expect(await manifestFiles(member.id)).toEqual([]);
    expect(await manifestFiles(organization.id)).toEqual(['src/org.ts']);
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
