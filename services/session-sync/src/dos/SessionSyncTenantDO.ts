import { DurableObject } from 'cloudflare:workers';
import { and, desc, eq, lt, or } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { z } from 'zod';

import migrations from '../../drizzle-tenant/migrations';
import { createdSessions, leases, usage, userErasure } from '../db/tenant-sqlite-schema';
import type { Env } from '../env';
import {
  LIMITS,
  fail,
  ok,
  sessionIDSchema,
  tenantSchema,
  type Result,
  type Tenant,
} from '../protocol';
import * as erasure from './session-sync/user-erasure';

const inputSchema = z.strictObject({
  tenant: tenantSchema,
  sessionID: sessionIDSchema,
  bytes: z
    .number()
    .int()
    .min(0)
    .max(LIMITS.sessionBlobBytes + LIMITS.sessionInlineBytes),
});

function configured(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('Invalid tenant quota');
  return parsed;
}

/** Serializes tenant admission; the personal tenant also owns its creator's erasure index. */
export class SessionSyncTenantDO extends DurableObject<Env> {
  private db;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = drizzle(ctx.storage, { logger: false });
    void ctx.blockConcurrencyWhile(async () => {
      await migrate(this.db, migrations);
      this.db.insert(usage).values({ id: 1, sessions: 0, bytes: 0 }).onConflictDoNothing().run();
      await erasure.schedule(this.db, ctx);
    });
  }

  async reserve(input: unknown): Promise<Result<{ bytes: number }>> {
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) return fail('invalid_request', 'Invalid tenant lease');
    const { tenant, sessionID, bytes } = parsed.data;
    const personal = tenant.type === 'user';
    const limits = {
      sessions: configured(
        personal ? this.env.USER_TENANT_SESSIONS : this.env.ORGANIZATION_TENANT_SESSIONS,
        personal ? LIMITS.userTenantSessions : LIMITS.organizationTenantSessions
      ),
      bytes: configured(
        personal ? this.env.USER_TENANT_BYTES : this.env.ORGANIZATION_TENANT_BYTES,
        personal ? LIMITS.userTenantBytes : LIMITS.organizationTenantBytes
      ),
    };
    return this.ctx.storage.transactionSync(() => {
      const prior = this.db.select().from(leases).where(eq(leases.session_id, sessionID)).get();
      const used = this.db.select().from(usage).where(eq(usage.id, 1)).get();
      if (!used) throw new Error('Tenant usage is missing');
      const sessions = used.sessions + (prior ? 0 : 1);
      const total = used.bytes + bytes - (prior?.bytes ?? 0);
      if (
        (!prior && sessions > limits.sessions) ||
        (bytes > (prior?.bytes ?? 0) && total > limits.bytes)
      )
        return fail('tenant_budget_exceeded', 'The tenant storage budget is exhausted', limits);
      this.db
        .insert(leases)
        .values({ session_id: sessionID, bytes })
        .onConflictDoUpdate({ target: leases.session_id, set: { bytes } })
        .run();
      this.db.update(usage).set({ sessions, bytes: total }).where(eq(usage.id, 1)).run();
      return ok({ bytes });
    });
  }

  async release(input: unknown): Promise<Result<null>> {
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) return fail('invalid_request', 'Invalid tenant lease');
    return this.ctx.storage.transactionSync(() => {
      const prior = this.db
        .delete(leases)
        .where(eq(leases.session_id, parsed.data.sessionID))
        .returning()
        .get();
      if (prior) {
        const used = this.db.select().from(usage).where(eq(usage.id, 1)).get();
        if (!used) throw new Error('Tenant usage is missing');
        this.db
          .update(usage)
          .set({ sessions: used.sessions - 1, bytes: used.bytes - prior.bytes })
          .where(eq(usage.id, 1))
          .run();
      }
      return ok(null);
    });
  }

  async trackCreatedSession(input: unknown): Promise<Result<null>> {
    return erasure.track(this.db, input);
  }

  async forgetCreatedSession(input: unknown): Promise<Result<null>> {
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) return fail('invalid_request', 'Invalid creator index entry');
    const { tenant, sessionID } = parsed.data;
    this.db
      .delete(createdSessions)
      .where(eq(createdSessions.target, JSON.stringify([tenant.type, tenant.id, sessionID])))
      .run();
    return ok(null);
  }

  async listCreatedSessions(input: unknown) {
    const parsed = z
      .strictObject({
        limit: z.number().int().min(1).max(100),
        before: z
          .strictObject({
            createdAt: z.number().int().nonnegative(),
            target: z.string().max(2048),
          })
          .optional(),
      })
      .safeParse(input);
    if (!parsed.success) return fail('invalid_request', 'Invalid session list page');
    if (this.db.select().from(userErasure).get()) {
      return ok({ items: [], next: null });
    }
    const { before, limit } = parsed.data;
    const rows = this.db
      .select()
      .from(createdSessions)
      .where(
        before
          ? or(
              lt(createdSessions.created_at, before.createdAt),
              and(
                eq(createdSessions.created_at, before.createdAt),
                lt(createdSessions.target, before.target)
              )
            )
          : undefined
      )
      .orderBy(desc(createdSessions.created_at), desc(createdSessions.target))
      .limit(limit + 1)
      .all();
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return ok({
      items: items.map(row => ({
        sessionID: row.session_id,
        tenant: { type: row.tenant_type, id: row.tenant_id },
        createdAt: row.created_at,
      })),
      next:
        rows.length > limit && last ? { createdAt: last.created_at, target: last.target } : null,
    });
  }
  async eraseUser(input: unknown): Promise<Result<null>> {
    return erasure.begin(this.db, this.ctx, input);
  }

  override async alarm(): Promise<void> {
    await erasure.alarm(this.db, this.ctx, this.env);
  }
}

export function getTenantStub(env: Pick<Env, 'SESSION_SYNC_TENANT_DO'>, tenant: Tenant) {
  const name = JSON.stringify([tenant.type, tenant.id]);
  return env.SESSION_SYNC_TENANT_DO.get(env.SESSION_SYNC_TENANT_DO.idFromName(name));
}
