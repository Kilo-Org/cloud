import { asc, eq } from 'drizzle-orm';
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { z } from 'zod';

import { createdSessions, userErasure } from '../../db/tenant-sqlite-schema';
import type { Env } from '../../env';
import {
  fail,
  ok,
  principalSchema,
  sessionIDSchema,
  userIDSchema,
  type Result,
} from '../../protocol';
import { getSessionSyncDOStub } from '../SessionSyncDO';

export const ERASURE_PAGE_ITEMS = 16;
const RETRY_MS = 60_000;
const trackInput = z.strictObject({ principal: principalSchema, sessionID: sessionIDSchema });
const eraseInput = z.strictObject({ userID: userIDSchema });
type Db = DrizzleSqliteDODatabase;

export function track(db: Db, input: unknown): Result<null> {
  const parsed = trackInput.safeParse(input);
  if (!parsed.success) return fail('invalid_request', 'Invalid creator index entry');
  if (db.select().from(userErasure).get())
    return fail('session_deleted', 'The account was deleted');
  const { principal, sessionID } = parsed.data;
  const tenant = principal.tenant;
  db.insert(createdSessions)
    .values({
      target: JSON.stringify([tenant.type, tenant.id, sessionID]),
      tenant_type: tenant.type,
      tenant_id: tenant.id,
      session_id: sessionID,
      created_at: Date.now(),
    })
    .onConflictDoNothing()
    .run();
  return ok(null);
}

/** The fence is durable before the deletion flow receives its acknowledgement. */
export async function begin(
  db: Db,
  ctx: DurableObjectState,
  input: unknown
): Promise<Result<null>> {
  const parsed = eraseInput.safeParse(input);
  if (!parsed.success) return fail('invalid_request', 'Invalid account erasure request');
  db.insert(userErasure).values({ id: 1, user_id: parsed.data.userID }).onConflictDoNothing().run();
  await schedule(db, ctx);
  return ok(null);
}

export async function schedule(db: Db, ctx: DurableObjectState): Promise<void> {
  if (!db.select().from(userErasure).get()) return;
  if (db.select({ target: createdSessions.target }).from(createdSessions).limit(1).get()) {
    await ctx.storage.setAlarm(Date.now() + 1000);
  }
}

/** Each successful entry is checkpointed separately; a lost reply can safely repeat it. */
export async function alarm(db: Db, ctx: DurableObjectState, env: Env): Promise<void> {
  const job = db.select().from(userErasure).get();
  if (!job) return;
  try {
    const page = db
      .select()
      .from(createdSessions)
      .orderBy(asc(createdSessions.target))
      .limit(ERASURE_PAGE_ITEMS)
      .all();
    for (const entry of page) {
      const tenant = { type: entry.tenant_type, id: entry.tenant_id };
      const result = await getSessionSyncDOStub(env, {
        tenant,
        sessionID: entry.session_id,
      }).eraseForUser({ principal: { userID: job.user_id, tenant }, sessionID: entry.session_id });
      if (!result.ok) throw new Error('Session account erasure unavailable');
      db.delete(createdSessions).where(eq(createdSessions.target, entry.target)).run();
    }
    await schedule(db, ctx);
  } catch (error) {
    await ctx.storage.setAlarm(Date.now() + RETRY_MS);
    console.error('session-sync account erasure failed', {
      error: error instanceof Error ? error.name : typeof error,
    });
    throw error;
  }
}
