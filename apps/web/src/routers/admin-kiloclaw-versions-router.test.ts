/* eslint-disable drizzle/enforce-delete-with-where */
import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import type { User } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import {
  kiloclaw_image_catalog,
  kiloclaw_instances,
  kiloclaw_version_pins,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

// Mock KiloClawInternalClient so tests don't require KILOCLAW_API_URL.
// The mock factory is hoisted above the imports below, but each
// mockImplementation runs only when the mocked method is called — by which
// time the regular ES imports (db, schema, eq) at the top of the file have
// been resolved and are safe to reference.
//
// disableImageAndClearRollout mimics the kiloclaw service's atomic SQL write
// so the post-call re-read in updateVersionStatus sees the disabled state.
jest.mock('@/lib/kiloclaw/kiloclaw-internal-client', () => ({
  KiloClawInternalClient: jest.fn().mockImplementation(() => ({
    getLatestVersion: jest.fn().mockResolvedValue(null),
    listVersions: jest.fn().mockResolvedValue([]),
    disableImageAndClearRollout: jest
      .fn()
      .mockImplementation(async (imageTag: string, updatedBy: string) => {
        await db
          .update(kiloclaw_image_catalog)
          .set({
            status: 'disabled',
            rollout_percent: 0,
            updated_by: updatedBy,
            updated_at: new Date().toISOString(),
          })
          .where(eq(kiloclaw_image_catalog.image_tag, imageTag));
        return { ok: true };
      }),
    // The DO-side behavior of applyPinnedVersion is covered in
    // services/kiloclaw/src/durable-objects/kiloclaw-instance.test.ts.
    // Here we just need the client to resolve successfully so setPin /
    // removePin don't surface a sync failure.
    applyPinnedVersion: jest
      .fn()
      .mockImplementation(async (_userId: string, _instanceId: string, imageTag: string | null) => {
        return {
          ok: true,
          openclawVersion: imageTag ? '2026.2.9' : null,
          imageTag,
          imageDigest: imageTag ? 'sha256:abc123' : null,
          variant: imageTag ? 'default' : null,
        };
      }),
  })),
  KiloClawApiError: class extends Error {
    readonly statusCode: number;
    constructor(statusCode: number) {
      super(`KiloClaw API error (${statusCode})`);
      this.statusCode = statusCode;
    }
  },
}));

let regularUser: User;
let adminUser: User;
let targetUser: User;
let targetInstanceId: string;

const catalogEntry = {
  openclaw_version: '2026.2.9',
  variant: 'default',
  image_tag: 'registry.fly.io/kiloclaw:test-v1',
  image_digest: 'sha256:abc123',
  status: 'available' as const,
  published_at: new Date().toISOString(),
};

const catalogEntry2 = {
  openclaw_version: '2026.2.10',
  variant: 'default',
  image_tag: 'registry.fly.io/kiloclaw:test-v2',
  image_digest: 'sha256:def456',
  status: 'available' as const,
  published_at: new Date().toISOString(),
};

beforeAll(async () => {
  regularUser = await insertTestUser({
    google_user_email: 'regular-kiloclaw-ver@example.com',
    is_admin: false,
  });
  adminUser = await insertTestUser({
    google_user_email: 'admin-kiloclaw-ver@admin.example.com',
    is_admin: true,
  });
  targetUser = await insertTestUser({
    google_user_email: 'target-kiloclaw-ver@example.com',
    is_admin: false,
  });

  const [instance] = await db
    .insert(kiloclaw_instances)
    .values({
      user_id: targetUser.id,
      sandbox_id: `test-admin-pin-${Date.now()}`,
    })
    .returning({ id: kiloclaw_instances.id });
  targetInstanceId = instance.id;

  await db.insert(kiloclaw_image_catalog).values([catalogEntry, catalogEntry2]);
});

afterAll(async () => {
  try {
    await db.delete(kiloclaw_version_pins);
    await db.delete(kiloclaw_instances).where(eq(kiloclaw_instances.id, targetInstanceId));
    await db
      .delete(kiloclaw_image_catalog)
      .where(eq(kiloclaw_image_catalog.image_tag, catalogEntry.image_tag));
    await db
      .delete(kiloclaw_image_catalog)
      .where(eq(kiloclaw_image_catalog.image_tag, catalogEntry2.image_tag));
  } catch {
    // Test DB may already be torn down by framework
  }
});

describe('admin.kiloclawVersions.listVersions', () => {
  it('throws FORBIDDEN for non-admin users', async () => {
    const caller = await createCallerForUser(regularUser.id);
    await expect(caller.admin.kiloclawVersions.listVersions({})).rejects.toThrow(
      'Admin access required'
    );
  });

  it('returns catalog entries with pagination', async () => {
    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.kiloclawVersions.listVersions({});

    expect(result.items.length).toBeGreaterThanOrEqual(2);
    expect(result.pagination.totalCount).toBeGreaterThanOrEqual(2);
    expect(result.items[0]).toHaveProperty('image_tag');
    expect(result.items[0]).toHaveProperty('openclaw_version');
  });

  it('filters by status', async () => {
    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.kiloclawVersions.listVersions({ status: 'disabled' });

    for (const item of result.items) {
      expect(item.status).toBe('disabled');
    }
  });

  it('sorts by image_tag asc', async () => {
    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.kiloclawVersions.listVersions({
      sortBy: 'image_tag',
      sortDir: 'asc',
      limit: 100,
    });

    // Scoped assertion: among only our two fixtures, v1 must come before v2.
    const tags = result.items.map(i => i.image_tag);
    const v1 = tags.indexOf(catalogEntry.image_tag);
    const v2 = tags.indexOf(catalogEntry2.image_tag);
    expect(v1).toBeGreaterThanOrEqual(0);
    expect(v2).toBeGreaterThan(v1);
  });

  it('sorts by image_tag desc', async () => {
    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.kiloclawVersions.listVersions({
      sortBy: 'image_tag',
      sortDir: 'desc',
      limit: 100,
    });

    const tags = result.items.map(i => i.image_tag);
    const v1 = tags.indexOf(catalogEntry.image_tag);
    const v2 = tags.indexOf(catalogEntry2.image_tag);
    expect(v2).toBeGreaterThanOrEqual(0);
    expect(v1).toBeGreaterThan(v2);
  });

  it('sorts by openclaw_version asc (numeric, not lex)', async () => {
    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.kiloclawVersions.listVersions({
      sortBy: 'openclaw_version',
      sortDir: 'asc',
      limit: 100,
    });

    const tags = result.items.map(i => i.image_tag);
    const v1 = tags.indexOf(catalogEntry.image_tag); // 2026.2.9
    const v2 = tags.indexOf(catalogEntry2.image_tag); // 2026.2.10
    expect(v1).toBeGreaterThanOrEqual(0);
    expect(v2).toBeGreaterThanOrEqual(0);
    // CalVer ordering: 2026.2.9 is OLDER than 2026.2.10, so v1 must
    // come before v2 in ascending order. A naive text sort would put
    // '2026.2.10' first ('1' < '9' lex), so this also catches a
    // regression to lex ordering.
    expect(v1).toBeLessThan(v2);
  });

  it('rejects an unknown sort column via zod', async () => {
    const caller = await createCallerForUser(adminUser.id);
    await expect(
      caller.admin.kiloclawVersions.listVersions({
        // @ts-expect-error - invalid sort column for this test
        sortBy: 'image_digest',
      })
    ).rejects.toThrow();
  });
});

describe('admin.kiloclawVersions.updateVersionStatus', () => {
  it('throws FORBIDDEN for non-admin users', async () => {
    const caller = await createCallerForUser(regularUser.id);
    await expect(
      caller.admin.kiloclawVersions.updateVersionStatus({
        imageTag: catalogEntry.image_tag,
        status: 'disabled',
      })
    ).rejects.toThrow('Admin access required');
  });

  it('updates status and records updated_by', async () => {
    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.kiloclawVersions.updateVersionStatus({
      imageTag: catalogEntry.image_tag,
      status: 'disabled',
    });

    expect(result.status).toBe('disabled');
    expect(result.updated_by).toBe(adminUser.id);
  });

  it('throws NOT_FOUND for non-existent image tag', async () => {
    const caller = await createCallerForUser(adminUser.id);
    await expect(
      caller.admin.kiloclawVersions.updateVersionStatus({
        imageTag: 'nonexistent-tag',
        status: 'disabled',
      })
    ).rejects.toThrow('Version not found');
  });

  afterAll(async () => {
    // Reset status for other tests
    await db
      .update(kiloclaw_image_catalog)
      .set({ status: 'available' })
      .where(eq(kiloclaw_image_catalog.image_tag, catalogEntry.image_tag));
  });
});

describe('admin.kiloclawVersions.bulkDisableVersions', () => {
  // Each test starts from a clean state: both catalog rows available,
  // neither marked :latest. Tests that mutate state set their own state up
  // and reset in afterEach.
  beforeEach(async () => {
    await db
      .update(kiloclaw_image_catalog)
      .set({ status: 'available', is_latest: false, rollout_percent: 0 })
      .where(eq(kiloclaw_image_catalog.image_tag, catalogEntry.image_tag));
    await db
      .update(kiloclaw_image_catalog)
      .set({ status: 'available', is_latest: false, rollout_percent: 0 })
      .where(eq(kiloclaw_image_catalog.image_tag, catalogEntry2.image_tag));
  });

  it('throws FORBIDDEN for non-admin users', async () => {
    const caller = await createCallerForUser(regularUser.id);
    await expect(
      caller.admin.kiloclawVersions.bulkDisableVersions({
        imageTags: [catalogEntry.image_tag],
      })
    ).rejects.toThrow('Admin access required');
  });

  it('disables a batch of available, non-:latest rows', async () => {
    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.kiloclawVersions.bulkDisableVersions({
      imageTags: [catalogEntry.image_tag, catalogEntry2.image_tag],
    });

    expect(result.disabled).toEqual(
      expect.arrayContaining([catalogEntry.image_tag, catalogEntry2.image_tag])
    );
    expect(result.disabled).toHaveLength(2);
    expect(result.skippedLatest).toEqual([]);
    expect(result.skippedAlreadyDisabled).toEqual([]);
    expect(result.notFound).toEqual([]);
    expect(result.errors).toEqual([]);

    const [r1, r2] = await Promise.all([
      db
        .select()
        .from(kiloclaw_image_catalog)
        .where(eq(kiloclaw_image_catalog.image_tag, catalogEntry.image_tag))
        .limit(1),
      db
        .select()
        .from(kiloclaw_image_catalog)
        .where(eq(kiloclaw_image_catalog.image_tag, catalogEntry2.image_tag))
        .limit(1),
    ]);
    expect(r1[0].status).toBe('disabled');
    expect(r1[0].rollout_percent).toBe(0);
    expect(r2[0].status).toBe('disabled');
    expect(r2[0].rollout_percent).toBe(0);
  });

  it('skips :latest rows without aborting the batch', async () => {
    await db
      .update(kiloclaw_image_catalog)
      .set({ is_latest: true })
      .where(eq(kiloclaw_image_catalog.image_tag, catalogEntry.image_tag));

    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.kiloclawVersions.bulkDisableVersions({
      imageTags: [catalogEntry.image_tag, catalogEntry2.image_tag],
    });

    expect(result.skippedLatest).toEqual([catalogEntry.image_tag]);
    expect(result.disabled).toEqual([catalogEntry2.image_tag]);

    // :latest row must be untouched.
    const [latestRow] = await db
      .select()
      .from(kiloclaw_image_catalog)
      .where(eq(kiloclaw_image_catalog.image_tag, catalogEntry.image_tag))
      .limit(1);
    expect(latestRow.status).toBe('available');
    expect(latestRow.is_latest).toBe(true);
  });

  it('skips already-disabled rows', async () => {
    await db
      .update(kiloclaw_image_catalog)
      .set({ status: 'disabled' })
      .where(eq(kiloclaw_image_catalog.image_tag, catalogEntry.image_tag));

    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.kiloclawVersions.bulkDisableVersions({
      imageTags: [catalogEntry.image_tag, catalogEntry2.image_tag],
    });

    expect(result.skippedAlreadyDisabled).toEqual([catalogEntry.image_tag]);
    expect(result.disabled).toEqual([catalogEntry2.image_tag]);
  });

  it('reports unknown tags in notFound and disables the rest', async () => {
    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.kiloclawVersions.bulkDisableVersions({
      imageTags: ['does-not-exist', catalogEntry.image_tag],
    });

    expect(result.notFound).toEqual(['does-not-exist']);
    expect(result.disabled).toEqual([catalogEntry.image_tag]);
  });

  it('rejects an empty array', async () => {
    const caller = await createCallerForUser(adminUser.id);
    await expect(
      caller.admin.kiloclawVersions.bulkDisableVersions({ imageTags: [] })
    ).rejects.toThrow();
  });

  it('rejects an oversized array (>50)', async () => {
    const caller = await createCallerForUser(adminUser.id);
    const tooMany = Array.from({ length: 51 }, (_, i) => `tag-${i}`);
    await expect(
      caller.admin.kiloclawVersions.bulkDisableVersions({ imageTags: tooMany })
    ).rejects.toThrow();
  });

  it('handles a mixed batch (1 ok + 1 :latest + 1 missing)', async () => {
    await db
      .update(kiloclaw_image_catalog)
      .set({ is_latest: true })
      .where(eq(kiloclaw_image_catalog.image_tag, catalogEntry.image_tag));

    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.kiloclawVersions.bulkDisableVersions({
      imageTags: [catalogEntry.image_tag, catalogEntry2.image_tag, 'missing-tag'],
    });

    expect(result.disabled).toEqual([catalogEntry2.image_tag]);
    expect(result.skippedLatest).toEqual([catalogEntry.image_tag]);
    expect(result.notFound).toEqual(['missing-tag']);
    expect(result.errors).toEqual([]);
  });

  it('continues the batch when a per-row call throws', async () => {
    // Override the mock's disableImageAndClearRollout to throw on the first
    // tag and succeed on the second. The procedure must record the failure
    // in `errors` and still disable the second tag.
    const mocked = jest.requireMock('@/lib/kiloclaw/kiloclaw-internal-client') as {
      KiloClawInternalClient: jest.Mock;
    };
    const ClientMock = mocked.KiloClawInternalClient;
    const originalImpl = ClientMock.getMockImplementation();

    ClientMock.mockImplementationOnce(() => ({
      disableImageAndClearRollout: jest
        .fn()
        .mockImplementation(async (imageTag: string, updatedBy: string) => {
          if (imageTag === catalogEntry.image_tag) {
            throw new Error('simulated kiloclaw failure');
          }
          await db
            .update(kiloclaw_image_catalog)
            .set({
              status: 'disabled',
              rollout_percent: 0,
              updated_by: updatedBy,
              updated_at: new Date().toISOString(),
            })
            .where(eq(kiloclaw_image_catalog.image_tag, imageTag));
          return { ok: true };
        }),
    }));

    try {
      const caller = await createCallerForUser(adminUser.id);
      const result = await caller.admin.kiloclawVersions.bulkDisableVersions({
        imageTags: [catalogEntry.image_tag, catalogEntry2.image_tag],
      });

      expect(result.errors).toEqual([
        { imageTag: catalogEntry.image_tag, message: 'simulated kiloclaw failure' },
      ]);
      expect(result.disabled).toEqual([catalogEntry2.image_tag]);
    } finally {
      // Restore the default mock impl for downstream tests.
      if (originalImpl) ClientMock.mockImplementation(originalImpl);
    }
  });
});

describe('admin.kiloclawVersions pin operations', () => {
  afterEach(async () => {
    await db.delete(kiloclaw_version_pins);
  });

  describe('setPin', () => {
    it('throws FORBIDDEN for non-admin users', async () => {
      const caller = await createCallerForUser(regularUser.id);
      await expect(
        caller.admin.kiloclawVersions.setPin({
          userId: targetUser.id,
          imageTag: catalogEntry.image_tag,
        })
      ).rejects.toThrow('Admin access required');
    });

    it('creates a pin for a user', async () => {
      const caller = await createCallerForUser(adminUser.id);
      const result = await caller.admin.kiloclawVersions.setPin({
        userId: targetUser.id,
        imageTag: catalogEntry.image_tag,
        reason: 'Testing older version',
      });

      expect(result.instance_id).toBe(targetInstanceId);
      expect(result.image_tag).toBe(catalogEntry.image_tag);
      expect(result.pinned_by).toBe(adminUser.id);
      expect(result.reason).toBe('Testing older version');
    });

    it('upserts pin when user already has one', async () => {
      const caller = await createCallerForUser(adminUser.id);

      await caller.admin.kiloclawVersions.setPin({
        userId: targetUser.id,
        imageTag: catalogEntry.image_tag,
        reason: 'First pin',
      });

      const updated = await caller.admin.kiloclawVersions.setPin({
        userId: targetUser.id,
        imageTag: catalogEntry2.image_tag,
        reason: 'Updated pin',
      });

      expect(updated.image_tag).toBe(catalogEntry2.image_tag);
      expect(updated.reason).toBe('Updated pin');

      // Verify only one pin exists
      const pins = await caller.admin.kiloclawVersions.listPins({});
      expect(pins.pagination.totalCount).toBe(1);
    });

    it('rejects pin to non-existent image tag (FK constraint)', async () => {
      const caller = await createCallerForUser(adminUser.id);
      await expect(
        caller.admin.kiloclawVersions.setPin({
          userId: targetUser.id,
          imageTag: 'nonexistent-tag',
        })
      ).rejects.toThrow();
    });

    it('reports worker_sync ok alongside the DB row', async () => {
      const caller = await createCallerForUser(adminUser.id);
      const result = await caller.admin.kiloclawVersions.setPin({
        userId: targetUser.id,
        imageTag: catalogEntry.image_tag,
      });

      expect(result.image_tag).toBe(catalogEntry.image_tag);
      expect(result.worker_sync).toEqual({
        ok: true,
        openclawVersion: '2026.2.9',
        imageTag: catalogEntry.image_tag,
      });
    });
  });

  describe('getUserPin', () => {
    it('returns null when user has no pin', async () => {
      const caller = await createCallerForUser(adminUser.id);
      const result = await caller.admin.kiloclawVersions.getUserPin({
        userId: targetUser.id,
      });
      expect(result).toBeNull();
    });

    it('returns pin with catalog metadata', async () => {
      const caller = await createCallerForUser(adminUser.id);

      await caller.admin.kiloclawVersions.setPin({
        userId: targetUser.id,
        imageTag: catalogEntry.image_tag,
      });

      const result = await caller.admin.kiloclawVersions.getUserPin({
        userId: targetUser.id,
      });
      expect(result).not.toBeNull();
      expect(result!.instance_id).toBe(targetInstanceId);
      expect(result!.image_tag).toBe(catalogEntry.image_tag);
      expect(result!.openclaw_version).toBe(catalogEntry.openclaw_version);
      expect(result!.variant).toBe(catalogEntry.variant);
      expect(result!.pinned_by_email).toBe(adminUser.google_user_email);
    });
  });

  describe('listPins', () => {
    it('returns pins with joined user and catalog data', async () => {
      const caller = await createCallerForUser(adminUser.id);

      await caller.admin.kiloclawVersions.setPin({
        userId: targetUser.id,
        imageTag: catalogEntry.image_tag,
        reason: 'Test reason',
      });

      const result = await caller.admin.kiloclawVersions.listPins({});
      expect(result.items.length).toBe(1);
      expect(result.pagination.totalCount).toBe(1);

      const pin = result.items[0];
      expect(pin.instance_id).toBe(targetInstanceId);
      expect(pin.user_email).toBe(targetUser.google_user_email);
      expect(pin.openclaw_version).toBe(catalogEntry.openclaw_version);
      expect(pin.pinned_by_email).toBe(adminUser.google_user_email);
      expect(pin.reason).toBe('Test reason');
    });
  });

  describe('removePin', () => {
    it('removes an existing pin', async () => {
      const caller = await createCallerForUser(adminUser.id);

      await caller.admin.kiloclawVersions.setPin({
        userId: targetUser.id,
        imageTag: catalogEntry.image_tag,
      });

      const result = await caller.admin.kiloclawVersions.removePin({
        instanceId: targetInstanceId,
      });
      expect(result.success).toBe(true);

      const pin = await caller.admin.kiloclawVersions.getUserPin({ userId: targetUser.id });
      expect(pin).toBeNull();
    });

    it('is idempotent when no pin exists — still pushes clear to DO so failed syncs are retryable', async () => {
      const caller = await createCallerForUser(adminUser.id);
      const result = await caller.admin.kiloclawVersions.removePin({
        instanceId: targetInstanceId,
      });
      expect(result.success).toBe(true);
      expect(result.deleted).toBe(false);
      expect(result.worker_sync).toEqual({ ok: true, openclawVersion: null, imageTag: null });
    });

    it('reports deleted=true and worker_sync ok on successful clear', async () => {
      const caller = await createCallerForUser(adminUser.id);
      await caller.admin.kiloclawVersions.setPin({
        userId: targetUser.id,
        imageTag: catalogEntry.image_tag,
      });

      const result = await caller.admin.kiloclawVersions.removePin({
        instanceId: targetInstanceId,
      });

      expect(result.success).toBe(true);
      expect(result.deleted).toBe(true);
      expect(result.worker_sync).toEqual({ ok: true, openclawVersion: null, imageTag: null });
    });
  });
});

describe('admin.kiloclawVersions.searchUsers', () => {
  it('throws FORBIDDEN for non-admin users', async () => {
    const caller = await createCallerForUser(regularUser.id);
    await expect(caller.admin.kiloclawVersions.searchUsers({ query: 'target' })).rejects.toThrow(
      'Admin access required'
    );
  });

  it('finds users by email', async () => {
    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.kiloclawVersions.searchUsers({
      query: 'target-kiloclaw',
    });

    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result.some(u => u.id === targetUser.id)).toBe(true);
  });

  it('finds users by exact id', async () => {
    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.kiloclawVersions.searchUsers({
      query: targetUser.id,
    });

    expect(result.some(u => u.id === targetUser.id)).toBe(true);
  });
});

describe('admin.kiloclawVersions instance-based search', () => {
  it('finds instances by exact id', async () => {
    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.kiloclawVersions.searchUsers({
      query: targetInstanceId,
    });

    expect(result).toHaveLength(0);
  });
});
