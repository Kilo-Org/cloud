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
// getLatestVersion returns null (no latest set) so disable-latest guard passes.
jest.mock('@/lib/kiloclaw/kiloclaw-internal-client', () => ({
  KiloClawInternalClient: jest.fn().mockImplementation(() => ({
    getLatestVersion: jest.fn().mockResolvedValue(null),
    listVersions: jest.fn().mockResolvedValue([]),
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

    it('throws NOT_FOUND when no pin exists', async () => {
      const caller = await createCallerForUser(adminUser.id);
      await expect(
        caller.admin.kiloclawVersions.removePin({ instanceId: targetInstanceId })
      ).rejects.toThrow('No pin found for this user');
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
