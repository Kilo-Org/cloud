import { afterAll, beforeAll, beforeEach, describe, expect, test } from '@jest/globals';
import { randomUUID } from 'crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  admin_action_audit_logs,
  code_indexing_manifest,
  type Organization,
  type User,
} from '@kilocode/db/schema';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { run } from './garbage-collect';

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

const OLD = '2025-12-01T00:00:00.000Z';

async function insertManifestRow(organizationId: string, kiloUserId: string) {
  await db.insert(code_indexing_manifest).values({
    organization_id: organizationId,
    kilo_user_id: kiloUserId,
    project_id: 'acme/app',
    git_branch: 'main',
    file_hash: randomUUID(),
    file_path: 'src/old.ts',
    chunk_count: 3,
    created_at: OLD,
  });
}

async function manifestCount(organizationId: string): Promise<number> {
  const rows = await db
    .select({ id: code_indexing_manifest.id })
    .from(code_indexing_manifest)
    .where(eq(code_indexing_manifest.organization_id, organizationId));
  return rows.length;
}

async function auditRows(actorId: string) {
  return db
    .select()
    .from(admin_action_audit_logs)
    .where(
      and(
        eq(admin_action_audit_logs.actor_id, actorId),
        eq(admin_action_audit_logs.action, 'code_index.delete_before_date')
      )
    );
}

describe('managed-indexing garbage-collect', () => {
  let operator: User;
  let nonStaff: User;
  let owner: User;
  let organization: Organization;

  beforeAll(async () => {
    const suffix = randomUUID().slice(0, 8);
    operator = await insertTestUser({
      id: randomUUID(),
      google_user_email: `code-index-gc-operator-${suffix}@example.com`,
      is_admin: true,
    });
    nonStaff = await insertTestUser({
      id: randomUUID(),
      google_user_email: `code-index-gc-member-${suffix}@example.com`,
    });
    owner = await insertTestUser({
      id: randomUUID(),
      google_user_email: `code-index-gc-owner-${suffix}@example.com`,
    });
    organization = await createTestOrganization(`Code Index GC ${suffix}`, owner.id, 0);
  });

  beforeEach(async () => {
    milvusDeletes().length = 0;
    await db
      .delete(code_indexing_manifest)
      .where(inArray(code_indexing_manifest.organization_id, [organization.id, owner.id]));
    await insertManifestRow(organization.id, owner.id);
    await insertManifestRow(owner.id, owner.id);
  });

  afterAll(async () => {
    await db
      .delete(code_indexing_manifest)
      .where(inArray(code_indexing_manifest.organization_id, [organization.id, owner.id]));
    await db
      .delete(admin_action_audit_logs)
      .where(inArray(admin_action_audit_logs.actor_id, [operator.id, nonStaff.id]));
  });

  test('purges one organization index without a web caller and records the operator', async () => {
    await run(organization.id, 'now', `--operator=${operator.google_user_email}`);

    expect(await manifestCount(organization.id)).toBe(0);
    expect(await manifestCount(owner.id)).toBe(1);
    expect(milvusDeletes()).toEqual([
      expect.objectContaining({
        filter: expect.stringContaining(`organization_id == "${organization.id}"`),
      }),
    ]);
    expect(await auditRows(operator.id)).toEqual([
      expect.objectContaining({
        outcome: 'success',
        actor_email: operator.google_user_email,
        target_type: 'organization',
        target_id: organization.id,
        metadata: expect.objectContaining({
          script: 'managed-indexing/garbage-collect',
          scope: 'organization',
          indexId: organization.id,
        }),
      }),
    ]);
  });

  test('purges a personal index under the account as its target', async () => {
    await db
      .delete(admin_action_audit_logs)
      .where(eq(admin_action_audit_logs.actor_id, operator.id));

    await run(owner.google_user_email, 'now', `--operator=${operator.google_user_email}`);

    expect(await manifestCount(owner.id)).toBe(0);
    expect(await manifestCount(organization.id)).toBe(1);
    expect(await auditRows(operator.id)).toEqual([
      expect.objectContaining({
        target_type: 'user',
        target_id: owner.id,
        metadata: expect.objectContaining({ scope: 'personal', indexId: owner.id }),
      }),
    ]);
  });

  test('refuses to run without an operator and changes nothing', async () => {
    await expect(run(organization.id, 'now')).rejects.toThrow('Usage:');

    expect(await manifestCount(organization.id)).toBe(1);
    expect(milvusDeletes()).toHaveLength(0);
  });

  test('refuses an operator who is not a current Kilo admin and changes nothing', async () => {
    await expect(
      run(organization.id, 'now', `--operator=${nonStaff.google_user_email}`)
    ).rejects.toThrow('is not a current, unblocked Kilo admin');

    expect(await manifestCount(organization.id)).toBe(1);
    expect(milvusDeletes()).toHaveLength(0);
    expect(await auditRows(nonStaff.id)).toEqual([]);
  });
});
