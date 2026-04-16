import { describe, expect, it, beforeAll, beforeEach, jest } from '@jest/globals';
import { db, cleanupDbForTest } from '@/lib/drizzle';
import {
  kiloclaw_earlybird_purchases,
  kiloclaw_instances,
  kiloclaw_subscriptions,
} from '@kilocode/db/schema';
import { insertTestUser } from '@/tests/helpers/user.helper';
import type { User } from '@kilocode/db/schema';

// ── Mocks ──────────────────────────────────────────────────────────────────

// Mock KiloClawInternalClient to avoid real HTTP calls
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockSendChatMessage: jest.Mock<any> = jest.fn();
jest.mock('@/lib/kiloclaw/kiloclaw-internal-client', () => {
  // Import the real KiloClawApiError so tests can throw it
  const actual: Record<string, unknown> = jest.requireActual(
    '@/lib/kiloclaw/kiloclaw-internal-client'
  );
  return {
    KiloClawInternalClient: jest.fn().mockImplementation(() => ({
      sendChatMessage: mockSendChatMessage,
    })),
    KiloClawApiError: actual.KiloClawApiError,
  };
});

jest.mock('next/headers', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fn = jest.fn as (...args: any[]) => jest.Mock<any>;
  return {
    cookies: fn().mockResolvedValue({ get: fn() }),
    headers: fn().mockReturnValue(new Map()),
  };
});

// ── Dynamic imports (after mocks) ──────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createCallerForUser: (userId: string) => Promise<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let KiloClawApiError: any;

beforeAll(async () => {
  const mod = await import('@/routers/test-utils');
  createCallerForUser = mod.createCallerForUser;
  const clientMod = await import('@/lib/kiloclaw/kiloclaw-internal-client');
  KiloClawApiError = clientMod.KiloClawApiError;
});

// ── Helpers ────────────────────────────────────────────────────────────────

let user: User;
let otherUser: User;

beforeEach(async () => {
  await cleanupDbForTest();
  mockSendChatMessage.mockReset();

  user = await insertTestUser({
    google_user_email: `sendchat-test-${Math.random()}@example.com`,
  });
  otherUser = await insertTestUser({
    google_user_email: `sendchat-other-${Math.random()}@example.com`,
  });
});

async function createActiveInstance(userId: string): Promise<string> {
  const [row] = await db
    .insert(kiloclaw_instances)
    .values({
      user_id: userId,
      sandbox_id: `sandbox-${userId.slice(0, 8)}`,
    })
    .returning();
  return row.id;
}

async function createDestroyedInstance(userId: string): Promise<string> {
  const [row] = await db
    .insert(kiloclaw_instances)
    .values({
      user_id: userId,
      sandbox_id: `sandbox-destroyed-${userId.slice(0, 8)}`,
      destroyed_at: new Date().toISOString(),
    })
    .returning();
  return row.id;
}

async function grantKiloClawAccess(userId: string, instanceId: string): Promise<void> {
  await db.insert(kiloclaw_subscriptions).values({
    user_id: userId,
    instance_id: instanceId,
    plan: 'standard',
    status: 'active',
    stripe_subscription_id: `sub_test_${crypto.randomUUID()}`,
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('kiloclaw.sendChatMessage', () => {
  describe('billing gate (clawAccessProcedure)', () => {
    it('rejects users without KiloClaw access', async () => {
      await createActiveInstance(user.id);
      const caller = await createCallerForUser(user.id);

      await expect(caller.kiloclaw.sendChatMessage({ message: 'test' })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    });

    it('allows users with active subscription', async () => {
      const instanceId = await createActiveInstance(user.id);
      await grantKiloClawAccess(user.id, instanceId);
      mockSendChatMessage.mockResolvedValue({ success: true, channelId: 'chan-1' });

      const caller = await createCallerForUser(user.id);
      const result = await caller.kiloclaw.sendChatMessage({ message: 'test' });
      expect(result.success).toBe(true);
    });
  });

  describe('ownership validation', () => {
    it('rejects when user has no active instance (no instanceId)', async () => {
      await db.insert(kiloclaw_earlybird_purchases).values({
        user_id: user.id,
        amount_cents: 2500,
      });
      const caller = await createCallerForUser(user.id);

      await expect(caller.kiloclaw.sendChatMessage({ message: 'test' })).rejects.toMatchObject({
        code: 'NOT_FOUND',
        message: 'No active KiloClaw instance found',
      });
    });

    it('rejects when instanceId belongs to another user', async () => {
      const accessInstanceId = await createActiveInstance(user.id);
      await grantKiloClawAccess(user.id, accessInstanceId);
      const otherInstanceId = await createActiveInstance(otherUser.id);

      const caller = await createCallerForUser(user.id);
      await expect(
        caller.kiloclaw.sendChatMessage({ instanceId: otherInstanceId, message: 'test' })
      ).rejects.toMatchObject({
        code: 'NOT_FOUND',
        message: 'No active KiloClaw instance found',
      });
    });

    it('rejects when instanceId points to a destroyed instance', async () => {
      const accessInstanceId = await createActiveInstance(user.id);
      await grantKiloClawAccess(user.id, accessInstanceId);
      const destroyedId = await createDestroyedInstance(user.id);

      const caller = await createCallerForUser(user.id);
      await expect(
        caller.kiloclaw.sendChatMessage({ instanceId: destroyedId, message: 'test' })
      ).rejects.toMatchObject({
        code: 'NOT_FOUND',
        message: 'No active KiloClaw instance found',
      });
    });

    it('allows sending to own active instance by instanceId', async () => {
      const instanceId = await createActiveInstance(user.id);
      await grantKiloClawAccess(user.id, instanceId);
      mockSendChatMessage.mockResolvedValue({ success: true, channelId: 'chan-1' });

      const caller = await createCallerForUser(user.id);
      const result = await caller.kiloclaw.sendChatMessage({
        instanceId,
        message: 'hello',
      });
      expect(result.success).toBe(true);
      expect(mockSendChatMessage).toHaveBeenCalledWith(user.id, 'hello', instanceId);
    });
  });

  describe('error translation (KiloClawApiError → TRPCError)', () => {
    beforeEach(async () => {
      const instanceId = await createActiveInstance(user.id);
      await grantKiloClawAccess(user.id, instanceId);
    });

    it('maps worker 400 to tRPC BAD_REQUEST', async () => {
      mockSendChatMessage.mockRejectedValue(new KiloClawApiError(400, '{"error":"bad input"}'));

      const caller = await createCallerForUser(user.id);
      await expect(caller.kiloclaw.sendChatMessage({ message: 'test' })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'bad input',
      });
    });

    it('maps worker 403 to tRPC FORBIDDEN', async () => {
      mockSendChatMessage.mockRejectedValue(new KiloClawApiError(403, '{"error":"forbidden"}'));

      const caller = await createCallerForUser(user.id);
      await expect(caller.kiloclaw.sendChatMessage({ message: 'test' })).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'forbidden',
      });
    });

    it('maps worker 404 to tRPC NOT_FOUND', async () => {
      mockSendChatMessage.mockRejectedValue(
        new KiloClawApiError(404, '{"error":"Stream Chat is not set up for this instance"}')
      );

      const caller = await createCallerForUser(user.id);
      await expect(caller.kiloclaw.sendChatMessage({ message: 'test' })).rejects.toMatchObject({
        code: 'NOT_FOUND',
        message: 'Stream Chat is not set up for this instance',
      });
    });

    it('maps worker 503 to tRPC PRECONDITION_FAILED', async () => {
      mockSendChatMessage.mockRejectedValue(
        new KiloClawApiError(503, '{"error":"Stream Chat is not configured"}')
      );

      const caller = await createCallerForUser(user.id);
      await expect(caller.kiloclaw.sendChatMessage({ message: 'test' })).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        message: 'Stream Chat is not configured',
      });
    });

    it('maps unknown worker errors to tRPC INTERNAL_SERVER_ERROR', async () => {
      mockSendChatMessage.mockRejectedValue(new KiloClawApiError(502, ''));

      const caller = await createCallerForUser(user.id);
      await expect(caller.kiloclaw.sendChatMessage({ message: 'test' })).rejects.toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to send chat message',
      });
    });

    it('maps non-KiloClawApiError to tRPC INTERNAL_SERVER_ERROR', async () => {
      mockSendChatMessage.mockRejectedValue(new Error('network error'));

      const caller = await createCallerForUser(user.id);
      await expect(caller.kiloclaw.sendChatMessage({ message: 'test' })).rejects.toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to send chat message',
      });
    });
  });
});
