import { describe, it, expect, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { ulid } from 'ulid';
import type { ConversationDO } from '../do/conversation-do';
import { bootstrapConversationForTest, unwrap } from './helpers';
import { attachments } from '../db/conversation-schema';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';

function getDO(name: string): DurableObjectStub<ConversationDO> {
  return env.CONVERSATION_DO.get(env.CONVERSATION_DO.idFromName(name));
}

describe('ConversationDO orphan attachment sweep', () => {
  it('deletes pending rows older than the TTL and purges their R2 objects', async () => {
    const conversationId = ulid();
    const stub = getDO(conversationId);
    await bootstrapConversationForTest(stub, { conversationId, creatorId: 'user-A' });

    const { attachmentId, r2Key } = await unwrap(
      stub.initAttachment({
        uploaderId: 'user-A',
        mimeType: 'image/png',
        size: 10,
        filename: 'orphan.png',
      })
    );

    // Back-date the pending row to 25 hours ago.
    const twentyFiveHoursAgo = Date.now() - 25 * 60 * 60 * 1000;
    await runInDurableObject(stub, async (_inst, state) => {
      const db = drizzle(state.storage, { logger: false });
      db.update(attachments)
        .set({ created_at: twentyFiveHoursAgo })
        .where(eq(attachments.id, attachmentId))
        .run();
    });

    const deleted: string[] = [];
    await runInDurableObject(stub, async instance => {
      const orig = instance.env.MEDIA_BUCKET.delete.bind(instance.env.MEDIA_BUCKET);
      const spy = vi.fn(async (key: string) => {
        deleted.push(key);
        return orig(key);
      });
      (instance.env.MEDIA_BUCKET as unknown as { delete: typeof spy }).delete = spy;
    });

    await runInDurableObject(stub, async instance => {
      await instance.alarm();
    });

    const rowAfter = await runInDurableObject(stub, async (_inst, state) => {
      const db = drizzle(state.storage, { logger: false });
      return db.select().from(attachments).where(eq(attachments.id, attachmentId)).get();
    });
    expect(rowAfter).toBeUndefined();
    expect(deleted).toContain(r2Key);
  });

  it('pulls the orphan-sweep alarm in when a far-future alarm is already pending', async () => {
    const conversationId = ulid();
    const stub = getDO(conversationId);
    await bootstrapConversationForTest(stub, { conversationId, creatorId: 'user-A' });

    // Pre-set a far-future alarm (48 h from now) to simulate a stale orphan-sweep alarm.
    const fortyEightHoursFromNow = Date.now() + 48 * 60 * 60 * 1000;
    await runInDurableObject(stub, async (_inst, state) => {
      await state.storage.setAlarm(fortyEightHoursFromNow);
    });

    // initAttachment calls scheduleOrphanSweepIfNeeded which should pull the alarm in.
    await stub.initAttachment({
      uploaderId: 'user-A',
      mimeType: 'image/png',
      size: 10,
      filename: 'test.png',
    });

    const alarmAfter = await runInDurableObject(stub, async (_inst, state) => {
      return state.storage.getAlarm();
    });

    // The alarm should now be ~24 h from now, not 48 h.
    const twentyFourHoursFromNow = Date.now() + 24 * 60 * 60 * 1000;
    expect(alarmAfter).not.toBeNull();
    expect(alarmAfter!).toBeLessThan(fortyEightHoursFromNow);
    // Allow a small margin (10 s) for test execution time.
    expect(alarmAfter!).toBeGreaterThan(twentyFourHoursFromNow - 10_000);
  });
});
