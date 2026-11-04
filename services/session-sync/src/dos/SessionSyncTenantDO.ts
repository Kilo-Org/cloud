import { DurableObject } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { z } from 'zod';

import migrations from '../../drizzle-tenant/migrations';
import { usage } from '../db/tenant-sqlite-schema';
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

/** Serializes session admission and byte leases for one tenant. */
export class SessionSyncTenantDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const db = drizzle(ctx.storage, { logger: false });
    void ctx.blockConcurrencyWhile(async () => {
      await migrate(db, migrations);
      db.insert(usage).values({ id: 1, sessions: 0, bytes: 0 }).onConflictDoNothing().run();
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
      const sql = this.ctx.storage.sql;
      const prior = sql
        .exec<{ bytes: number }>('SELECT bytes FROM leases WHERE session_id = ?', sessionID)
        .toArray()[0];
      const usage = sql
        .exec<{ sessions: number; bytes: number }>('SELECT sessions, bytes FROM usage WHERE id = 1')
        .one();
      const sessions = usage.sessions + (prior ? 0 : 1);
      const total = usage.bytes + bytes - (prior?.bytes ?? 0);
      if (
        (!prior && sessions > limits.sessions) ||
        (bytes > (prior?.bytes ?? 0) && total > limits.bytes)
      ) {
        return fail('tenant_budget_exceeded', 'The tenant storage budget is exhausted', limits);
      }
      sql.exec(
        'INSERT INTO leases VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET bytes = excluded.bytes',
        sessionID,
        bytes
      );
      sql.exec('UPDATE usage SET sessions = ?, bytes = ? WHERE id = 1', sessions, total);
      return ok({ bytes });
    });
  }

  async release(input: unknown): Promise<Result<null>> {
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) return fail('invalid_request', 'Invalid tenant lease');
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const prior = sql
        .exec<{ bytes: number }>(
          'DELETE FROM leases WHERE session_id = ? RETURNING bytes',
          parsed.data.sessionID
        )
        .toArray()[0];
      if (prior)
        sql.exec(
          'UPDATE usage SET sessions = sessions - 1, bytes = bytes - ? WHERE id = 1',
          prior.bytes
        );
      return ok(null);
    });
  }
}

export function getTenantStub(env: Pick<Env, 'SESSION_SYNC_TENANT_DO'>, tenant: Tenant) {
  const name = JSON.stringify([tenant.type, tenant.id]);
  return env.SESSION_SYNC_TENANT_DO.get(env.SESSION_SYNC_TENANT_DO.idFromName(name));
}
