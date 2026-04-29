/* eslint-disable drizzle/enforce-delete-with-where */
import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import type { User } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import {
  kiloclaw_image_catalog,
  kiloclaw_instances,
  kiloclaw_version_pins,
  kiloclaw_subscriptions,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

/* eslint-disable @typescript-eslint/no-explicit-any */
const mockRestartMachine: jest.Mock<any, any> = jest.fn();
/* eslint-enable @typescript-eslint/no-explicit-any */

jest.mock('@/lib/kiloclaw/kiloclaw-user-client', () => ({
  KiloClawUserClient: jest.fn().mockImplementation(() => ({
    restartMachine: mockRestartMachine,
  })),
}));

let userA: User;
let userB: User;
let adminUser: User;
let userAInstanceId: string;
let userBInstanceId: string;
let adminInstanceId: string;

const availableVersion = {
  openclaw_version: '2026.2.9',
  variant: 'default',
  image_tag: 'registry.fly.io/kiloclaw:test-available',
  image_digest: 'sha256:abc123',
  status: 'available' as const,
  published_at: new Date().toISOString(),
};

const disabledVersion = {
  openclaw_version: '2026.2.8',
  variant: 'default',
  image_tag: 'registry.fly.io/kiloclaw:test-disabled',
  image_digest: 'sha256:def456',
  status: 'disabled' as const,
  published_at: new Date(Date.now() - 86400000).toISOString(), // 1 day ago
};

beforeAll(async () => {
  userA = await insertTestUser({
    google_user_email: 'user-a-kiloclaw-pin@example.com',
    is_admin: false,
  });
  userB = await insertTestUser({
    google_user_email: 'user-b-kiloclaw-pin@example.com',
    is_admin: false,
  });
  adminUser = await insertTestUser({
    google_user_email: 'admin-kiloclaw-pin@example.com',
    is_admin: true,
  });

  const [userAInstance] = await db
    .insert(kiloclaw_instances)
    .values({ user_id: userA.id, sandbox_id: `test-pin-a-${Date.now()}` })
    .returning({ id: kiloclaw_instances.id });
  userAInstanceId = userAInstance.id;

  const [userBInstance] = await db
    .insert(kiloclaw_instances)
    .values({ user_id: userB.id, sandbox_id: `test-pin-b-${Date.now()}` })
    .returning({ id: kiloclaw_instances.id });
  userBInstanceId = userBInstance.id;

  const [adminInstance] = await db
    .insert(kiloclaw_instances)
    .values({ user_id: adminUser.id, sandbox_id: `test-pin-admin-${Date.now()}` })
    .returning({ id: kiloclaw_instances.id });
  adminInstanceId = adminInstance.id;

  // Give test users active subscriptions so clawAccessProcedure doesn't block them
  const trialEnd = new Date(Date.now() + 7 * 86_400_000).toISOString();
  await db.insert(kiloclaw_subscriptions).values(
    [
      { user: userA, instanceId: userAInstanceId },
      { user: userB, instanceId: userBInstanceId },
      { user: adminUser, instanceId: adminInstanceId },
    ].map(({ user, instanceId }) => ({
      user_id: user.id,
      instance_id: instanceId,
      plan: 'trial' as const,
      status: 'trialing' as const,
      trial_started_at: new Date().toISOString(),
      trial_ends_at: trialEnd,
    }))
  );

  await db.insert(kiloclaw_image_catalog).values([availableVersion, disabledVersion]);
});

afterAll(async () => {
  try {
    await db.delete(kiloclaw_version_pins);
    await db.delete(kiloclaw_instances).where(eq(kiloclaw_instances.id, userAInstanceId));
    await db.delete(kiloclaw_instances).where(eq(kiloclaw_instances.id, userBInstanceId));
    await db.delete(kiloclaw_instances).where(eq(kiloclaw_instances.id, adminInstanceId));
    for (const u of [userA, userB, adminUser]) {
      await db.delete(kiloclaw_subscriptions).where(eq(kiloclaw_subscriptions.user_id, u.id));
    }
    await db
      .delete(kiloclaw_image_catalog)
      .where(eq(kiloclaw_image_catalog.image_tag, availableVersion.image_tag));
    await db
      .delete(kiloclaw_image_catalog)
      .where(eq(kiloclaw_image_catalog.image_tag, disabledVersion.image_tag));
  } catch {
    // Test DB may already be torn down by framework
  }
});

describe('kiloclaw.listAvailableVersions', () => {
  it('returns only available versions', async () => {
    const caller = await createCallerForUser(userA.id);
    const result = await caller.kiloclaw.listAvailableVersions({});

    expect(result.items.length).toBeGreaterThanOrEqual(1);
    for (const item of result.items) {
      // Disabled versions should not be in the list
      expect(item.image_tag).not.toBe(disabledVersion.image_tag);
    }

    // Available version should be in the list
    const hasAvailable = result.items.some(item => item.image_tag === availableVersion.image_tag);
    expect(hasAvailable).toBe(true);
  });

  it('returns pagination metadata', async () => {
    const caller = await createCallerForUser(userA.id);
    const result = await caller.kiloclaw.listAvailableVersions({ limit: 10 });

    expect(result.pagination).toHaveProperty('offset');
    expect(result.pagination).toHaveProperty('limit');
    expect(result.pagination).toHaveProperty('totalCount');
    expect(result.pagination).toHaveProperty('totalPages');
  });
});

describe('kiloclaw.getMyPin', () => {
  it('returns null when user has no pin', async () => {
    const caller = await createCallerForUser(userA.id);
    const result = await caller.kiloclaw.getMyPin();

    expect(result).toBeNull();
  });

  it('returns pin details when user has a pin', async () => {
    // Create a pin for userB
    await db.insert(kiloclaw_version_pins).values({
      instance_id: userBInstanceId,
      image_tag: availableVersion.image_tag,
      pinned_by: userB.id,
      reason: 'Testing',
    });

    const caller = await createCallerForUser(userB.id);
    const result = await caller.kiloclaw.getMyPin();

    expect(result).not.toBeNull();
    expect(result?.image_tag).toBe(availableVersion.image_tag);
    expect(result?.reason).toBe('Testing');
    expect(result?.openclaw_version).toBe(availableVersion.openclaw_version);
    expect(result?.variant).toBe(availableVersion.variant);

    // Cleanup
    await db
      .delete(kiloclaw_version_pins)
      .where(eq(kiloclaw_version_pins.instance_id, userBInstanceId));
  });
});

describe('kiloclaw.setMyPin', () => {
  afterEach(async () => {
    // Cleanup pins after each test
    await db
      .delete(kiloclaw_version_pins)
      .where(eq(kiloclaw_version_pins.instance_id, userAInstanceId));
  });

  it('creates a new pin for the user', async () => {
    const caller = await createCallerForUser(userA.id);
    const result = await caller.kiloclaw.setMyPin({
      imageTag: availableVersion.image_tag,
      reason: 'Testing new pin',
    });

    expect(result.instance_id).toBe(userAInstanceId);
    expect(result.image_tag).toBe(availableVersion.image_tag);
    expect(result.pinned_by).toBe(userA.id); // User pins themselves
    expect(result.reason).toBe('Testing new pin');
  });

  it('updates existing pin when called again', async () => {
    const caller = await createCallerForUser(userA.id);

    // Create initial pin
    await caller.kiloclaw.setMyPin({
      imageTag: availableVersion.image_tag,
      reason: 'Initial reason',
    });

    // Update pin (this should be an upsert)
    const result = await caller.kiloclaw.setMyPin({
      imageTag: availableVersion.image_tag,
      reason: 'Updated reason',
    });

    expect(result.reason).toBe('Updated reason');

    // Verify only one pin exists
    const pins = await db
      .select()
      .from(kiloclaw_version_pins)
      .where(eq(kiloclaw_version_pins.instance_id, userAInstanceId));
    expect(pins.length).toBe(1);
  });

  it('throws error when pinning to non-existent version', async () => {
    const caller = await createCallerForUser(userA.id);

    await expect(
      caller.kiloclaw.setMyPin({
        imageTag: 'registry.fly.io/kiloclaw:non-existent',
      })
    ).rejects.toThrow('not found in catalog');
  });

  it('throws error when pinning to disabled version', async () => {
    const caller = await createCallerForUser(userA.id);

    await expect(
      caller.kiloclaw.setMyPin({
        imageTag: disabledVersion.image_tag,
      })
    ).rejects.toThrow("Cannot pin to version with status 'disabled'");
  });

  it('allows pinning without a reason', async () => {
    const caller = await createCallerForUser(userA.id);
    const result = await caller.kiloclaw.setMyPin({
      imageTag: availableVersion.image_tag,
    });

    expect(result.reason).toBeNull();
  });
});

describe('kiloclaw.removeMyPin', () => {
  it('removes the user pin', async () => {
    // Create a pin first
    await db.insert(kiloclaw_version_pins).values({
      instance_id: userAInstanceId,
      image_tag: availableVersion.image_tag,
      pinned_by: userA.id,
    });

    const caller = await createCallerForUser(userA.id);
    const result = await caller.kiloclaw.removeMyPin();

    expect(result.success).toBe(true);

    // Verify pin is deleted
    const pins = await db
      .select()
      .from(kiloclaw_version_pins)
      .where(eq(kiloclaw_version_pins.instance_id, userAInstanceId));
    expect(pins.length).toBe(0);
  });

  it('is idempotent when no pin exists — still pushes clear to DO so failed syncs are retryable', async () => {
    const caller = await createCallerForUser(userA.id);

    const result = await caller.kiloclaw.removeMyPin();
    expect(result.success).toBe(true);
    expect(result.deleted).toBe(false);
    // DO sync may fail in tests (no KILOCLAW_API_URL); the point is the
    // mutation does not throw NOT_FOUND, so a UI retry can succeed.
    expect(result.worker_sync).toBeDefined();
  });
});

describe('Authorization', () => {
  beforeEach(async () => {
    // Create pins for both users
    await db.insert(kiloclaw_version_pins).values([
      {
        instance_id: userAInstanceId,
        image_tag: availableVersion.image_tag,
        pinned_by: userA.id,
      },
      {
        instance_id: userBInstanceId,
        image_tag: availableVersion.image_tag,
        pinned_by: userB.id,
      },
    ]);
  });

  afterEach(async () => {
    await db.delete(kiloclaw_version_pins);
  });

  it('getMyPin only returns the current user pin', async () => {
    const callerA = await createCallerForUser(userA.id);
    const resultA = await callerA.kiloclaw.getMyPin();

    expect(resultA?.instance_id).toBe(userAInstanceId);

    const callerB = await createCallerForUser(userB.id);
    const resultB = await callerB.kiloclaw.getMyPin();

    expect(resultB?.instance_id).toBe(userBInstanceId);
  });

  it("removeMyPin only touches the caller's own instance", async () => {
    const callerA = await createCallerForUser(userA.id);
    await callerA.kiloclaw.removeMyPin();

    // UserA's pin (on UserA's instance) should be deleted.
    const pinsA = await db
      .select()
      .from(kiloclaw_version_pins)
      .where(eq(kiloclaw_version_pins.instance_id, userAInstanceId));
    expect(pinsA.length).toBe(0);

    // UserB's pin (on a different instance) is untouched. Pin removal is
    // scoped to the caller's active instance, not to who originally set
    // the pin row.
    const pinsB = await db
      .select()
      .from(kiloclaw_version_pins)
      .where(eq(kiloclaw_version_pins.instance_id, userBInstanceId));
    expect(pinsB.length).toBe(1);
  });
});

describe('Pin metadata mutations are unrestricted by who set the pin', () => {
  // Pins are advisory consent metadata — either the user or an admin can
  // write/replace/delete the pin at any time. Override awareness lives on
  // the upgrade/downgrade paths via the consent dialog, not on these
  // metadata mutations.
  afterEach(async () => {
    await db
      .delete(kiloclaw_version_pins)
      .where(eq(kiloclaw_version_pins.instance_id, userAInstanceId));
  });

  it('setMyPin overwrites an admin-set pin with a user-set pin', async () => {
    await db.insert(kiloclaw_version_pins).values({
      instance_id: userAInstanceId,
      image_tag: availableVersion.image_tag,
      pinned_by: adminUser.id,
      reason: 'Admin set this',
    });

    const caller = await createCallerForUser(userA.id);
    const result = await caller.kiloclaw.setMyPin({
      imageTag: availableVersion.image_tag,
      reason: 'User overrides',
    });

    expect(result.pinned_by).toBe(userA.id);
    expect(result.reason).toBe('User overrides');

    // The single pin row is now owned by the user.
    const pins = await db
      .select()
      .from(kiloclaw_version_pins)
      .where(eq(kiloclaw_version_pins.instance_id, userAInstanceId));
    expect(pins.length).toBe(1);
    expect(pins[0].pinned_by).toBe(userA.id);
  });

  it('removeMyPin clears an admin-set pin', async () => {
    await db.insert(kiloclaw_version_pins).values({
      instance_id: userAInstanceId,
      image_tag: availableVersion.image_tag,
      pinned_by: adminUser.id,
    });

    const caller = await createCallerForUser(userA.id);
    const result = await caller.kiloclaw.removeMyPin();

    expect(result.success).toBe(true);
    expect(result.deleted).toBe(true);

    const pins = await db
      .select()
      .from(kiloclaw_version_pins)
      .where(eq(kiloclaw_version_pins.instance_id, userAInstanceId));
    expect(pins.length).toBe(0);
  });

  it('setMyPin succeeds when user has self-set pin', async () => {
    await db.insert(kiloclaw_version_pins).values({
      instance_id: userAInstanceId,
      image_tag: availableVersion.image_tag,
      pinned_by: userA.id,
    });

    const caller = await createCallerForUser(userA.id);
    const result = await caller.kiloclaw.setMyPin({
      imageTag: availableVersion.image_tag,
      reason: 'Updated by user',
    });

    expect(result.reason).toBe('Updated by user');
    expect(result.pinned_by).toBe(userA.id);
  });
});

describe('kiloclaw.restartMachine pin consent gate', () => {
  beforeEach(() => {
    mockRestartMachine.mockReset();
    mockRestartMachine.mockResolvedValue({ success: true, message: 'restarting' });
  });

  afterEach(async () => {
    await db
      .delete(kiloclaw_version_pins)
      .where(eq(kiloclaw_version_pins.instance_id, userAInstanceId));
  });

  it('plain restart (no imageTag) ignores pin state and never triggers the gate', async () => {
    await db.insert(kiloclaw_version_pins).values({
      instance_id: userAInstanceId,
      image_tag: availableVersion.image_tag,
      pinned_by: userA.id,
    });

    const caller = await createCallerForUser(userA.id);
    const result = await caller.kiloclaw.restartMachine();

    expect(result.success).toBe(true);
    expect(mockRestartMachine).toHaveBeenCalledWith(undefined, expect.any(Object));

    // Pin must remain untouched on plain restart.
    const pins = await db
      .select()
      .from(kiloclaw_version_pins)
      .where(eq(kiloclaw_version_pins.instance_id, userAInstanceId));
    expect(pins.length).toBe(1);
  });

  it('upgrade with no pin succeeds without acknowledgePinRemoval', async () => {
    const caller = await createCallerForUser(userA.id);
    const result = await caller.kiloclaw.restartMachine({ imageTag: 'latest' });

    expect(result.success).toBe(true);
    expect(mockRestartMachine).toHaveBeenCalledWith({ imageTag: 'latest' }, expect.any(Object));
  });

  it('upgrade with user-set pin and no acknowledgement throws PRECONDITION_FAILED with PIN_EXISTS', async () => {
    await db.insert(kiloclaw_version_pins).values({
      instance_id: userAInstanceId,
      image_tag: availableVersion.image_tag,
      pinned_by: userA.id,
    });

    const caller = await createCallerForUser(userA.id);
    await expect(caller.kiloclaw.restartMachine({ imageTag: 'latest' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'PIN_EXISTS',
    });

    // Worker must NOT be called when the gate blocks.
    expect(mockRestartMachine).not.toHaveBeenCalled();

    // Pin must remain in place after a blocked attempt.
    const pins = await db
      .select()
      .from(kiloclaw_version_pins)
      .where(eq(kiloclaw_version_pins.instance_id, userAInstanceId));
    expect(pins.length).toBe(1);
  });

  it('upgrade with user-set pin and acknowledgePinRemoval=true deletes pin and proceeds', async () => {
    await db.insert(kiloclaw_version_pins).values({
      instance_id: userAInstanceId,
      image_tag: availableVersion.image_tag,
      pinned_by: userA.id,
    });

    const caller = await createCallerForUser(userA.id);
    const result = await caller.kiloclaw.restartMachine({
      imageTag: 'latest',
      acknowledgePinRemoval: true,
    });

    expect(result.success).toBe(true);
    expect(mockRestartMachine).toHaveBeenCalledWith({ imageTag: 'latest' }, expect.any(Object));

    // Pin row removed.
    const pins = await db
      .select()
      .from(kiloclaw_version_pins)
      .where(eq(kiloclaw_version_pins.instance_id, userAInstanceId));
    expect(pins.length).toBe(0);
  });

  it('upgrade against an admin-set pin without ack throws PRECONDITION_FAILED (consent gate, not lock-in)', async () => {
    await db.insert(kiloclaw_version_pins).values({
      instance_id: userAInstanceId,
      image_tag: availableVersion.image_tag,
      pinned_by: adminUser.id,
    });

    const caller = await createCallerForUser(userA.id);
    await expect(caller.kiloclaw.restartMachine({ imageTag: 'latest' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'PIN_EXISTS',
    });

    expect(mockRestartMachine).not.toHaveBeenCalled();

    // Admin pin must remain in place when the user has not yet consented.
    const pins = await db
      .select()
      .from(kiloclaw_version_pins)
      .where(eq(kiloclaw_version_pins.instance_id, userAInstanceId));
    expect(pins.length).toBe(1);
    expect(pins[0].pinned_by).toBe(adminUser.id);
  });

  it('upgrade against an admin-set pin with ack=true deletes the pin and proceeds', async () => {
    // Pins are advisory consent gates; an informed user can override an
    // admin pin via Upgrade just like their own pin. Either party can
    // re-pin after if they want to block the next change.
    await db.insert(kiloclaw_version_pins).values({
      instance_id: userAInstanceId,
      image_tag: availableVersion.image_tag,
      pinned_by: adminUser.id,
    });

    const caller = await createCallerForUser(userA.id);
    const result = await caller.kiloclaw.restartMachine({
      imageTag: 'latest',
      acknowledgePinRemoval: true,
    });

    expect(result.success).toBe(true);
    expect(mockRestartMachine).toHaveBeenCalledWith({ imageTag: 'latest' }, expect.any(Object));

    // Admin pin removed.
    const pins = await db
      .select()
      .from(kiloclaw_version_pins)
      .where(eq(kiloclaw_version_pins.instance_id, userAInstanceId));
    expect(pins.length).toBe(0);
  });
});
