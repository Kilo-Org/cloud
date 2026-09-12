import { DurableObject } from 'cloudflare:workers';
import type { AuthRequest } from '@cloudflare/workers-oauth-provider';
import { and, eq, gt, isNull, lt } from 'drizzle-orm';
import { drizzle, type DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import migrations from '../../drizzle/migrations';
import { oauthPendingAuthorizations, oauthRefreshTokenHistory } from '../db/sqlite-schema';
import type { RefreshReuseStore, RefreshTokenParts } from '../oauth/refresh-reuse';

/**
 * KiloMcpOAuthStore — the only hand-rolled OAuth state the library does not own
 * (s2): the short-lived pending-authorization records that bridge GET
 * /authorize to the apps/web device-auth pairing. Clients, codes, refresh
 * tokens, and revoked jtis are owned by `@cloudflare/workers-oauth-provider`
 * (OAUTH_KV); this store holds pending authorizations and issued refresh-token
 * hashes for strict replay detection via Drizzle's query builder.
 *
 * The pending records are one logical namespace (any worker instance must see
 * any record), so a single SQLite DO instance (`getByName(STORE_INSTANCE_NAME)`)
 * is the coordination atom. Volume is auth traffic only, not MCP tool calls.
 *
 * Every write carries `nowIso` from the caller so expiry semantics are
 * deterministic under test; the DO never reads the clock for authorization
 * decisions. Rows are structured-clone-safe plain objects.
 *
 * Never log tokens, hashes, or identities from these records.
 */

/** Fixed instance name for the single global registry. */
const STORE_INSTANCE_NAME = 'kilo-mcp-oauth';

/** Interval between expired-row purges (DO alarm). */
const PURGE_INTERVAL_MS = 6 * 60 * 60 * 1000;

export type PendingAuthorizationStatus =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'expired'
  | 'completed';

/**
 * A short-lived pending-authorization record: the library AuthRequest JSON plus
 * the apps/web device-auth pairing it is waiting on. Created at GET /authorize,
 * read by /authorize/status and /authorize/org, and consumed by the library's
 * authorize handler.
 */
export type PendingAuthorization = {
  id: string;
  /** The parsed library authorization request, stored as JSON. */
  authRequest: AuthRequest;
  deviceAuthCode: string;
  status: PendingAuthorizationStatus;
  kiloUserId: string | null;
  organizationId: string | null;
  /** Kilo API token from the approved pairing; never log it. */
  kiloToken: string | null;
  createdAt: string;
  expiresAt: string;
};

export type NewPendingAuthorization = {
  id: string;
  authRequest: AuthRequest;
  deviceAuthCode: string;
  createdAt: string;
  /** ISO timestamp; the record is only actionable until then. */
  expiresAt: string;
};

/**
 * The RPC surface the auth endpoints depend on. The DurableObjectStub of
 * KiloMcpOAuthStore satisfies it structurally; unit tests pass an in-memory
 * fake. Kept as an interface so handlers never touch the namespace binding.
 */
export interface OAuthStoreApi {
  /**
   * Record the approved Kilo pairing while the record is still pending (s6):
   * binds `{ kiloUserId, kiloToken }` without choosing an org. The upstream
   * device-auth poll is single-use, so this write is what stops the status
   * endpoint from ever polling apps/web twice for one pairing. The first
   * writer wins (`kilo_user_id IS NULL`); a second call never overwrites the
   * stored token.
   */
  recordPairingApproval(
    deviceAuthCode: string,
    identity: { kiloUserId: string; kiloToken: string },
    nowIso: string
  ): Promise<boolean>;
  /** Insert a fresh pending authorization (status 'pending'). */
  createPendingAuthorization(input: NewPendingAuthorization): Promise<void>;
  getPendingAuthorization(id: string): Promise<PendingAuthorization | null>;
  /** pending -> denied after the user denied the Kilo pairing upstream (s2). */
  denyPendingAuthorization(deviceAuthCode: string, nowIso: string): Promise<boolean>;
  /** pending -> expired after apps/web reported the pairing expired upstream (s2). */
  expirePendingAuthorization(deviceAuthCode: string, nowIso: string): Promise<boolean>;
  /** pending -> approved with the Kilo identity; false when not actionable-pending (s2). */
  approvePendingAuthorization(
    deviceAuthCode: string,
    identity: { kiloUserId: string; organizationId: string | null },
    nowIso: string
  ): Promise<boolean>;
  /** Terminal transition: approved -> completed once the library issues the code (s2). */
  completePendingAuthorization(id: string, nowIso: string): Promise<boolean>;
  /**
   * Housekeeping: drop pending-authorization rows past their own expiry.
   * Returns the deleted row count.
   */
  purgeExpired(nowIso: string): Promise<number>;
}

function rowToPendingAuthorization(
  row: typeof oauthPendingAuthorizations.$inferSelect
): PendingAuthorization {
  return {
    id: row.id,
    authRequest: JSON.parse(row.auth_request) as AuthRequest,
    deviceAuthCode: row.device_auth_code,
    status: row.status,
    kiloUserId: row.kilo_user_id,
    organizationId: row.organization_id,
    kiloToken: row.kilo_token,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export class KiloMcpOAuthStore
  extends DurableObject<Env>
  implements OAuthStoreApi, RefreshReuseStore
{
  private readonly db: DrizzleSqliteDODatabase;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = drizzle(ctx.storage);
    void ctx.blockConcurrencyWhile(async () => {
      await migrate(this.db, migrations);
      if ((await ctx.storage.getAlarm()) === null) {
        await ctx.storage.setAlarm(Date.now() + PURGE_INTERVAL_MS);
      }
    });
  }

  async recordPairingApproval(
    deviceAuthCode: string,
    identity: { kiloUserId: string; kiloToken: string },
    nowIso: string
  ): Promise<boolean> {
    // `kilo_user_id IS NULL` keeps this first-writer-wins: the upstream poll
    // that returned the token is never re-run, and a racing second poll can
    // not overwrite the stored credential.
    const row = this.db
      .update(oauthPendingAuthorizations)
      .set({ kilo_user_id: identity.kiloUserId, kilo_token: identity.kiloToken })
      .where(
        and(
          eq(oauthPendingAuthorizations.device_auth_code, deviceAuthCode),
          eq(oauthPendingAuthorizations.status, 'pending'),
          isNull(oauthPendingAuthorizations.kilo_user_id),
          gt(oauthPendingAuthorizations.expires_at, nowIso)
        )
      )
      .returning({ id: oauthPendingAuthorizations.id })
      .get();
    return row !== undefined;
  }

  async createPendingAuthorization(input: NewPendingAuthorization): Promise<void> {
    this.db
      .insert(oauthPendingAuthorizations)
      .values({
        id: input.id,
        auth_request: JSON.stringify(input.authRequest),
        device_auth_code: input.deviceAuthCode,
        status: 'pending',
        created_at: input.createdAt,
        expires_at: input.expiresAt,
      })
      .run();
  }

  async getPendingAuthorization(id: string): Promise<PendingAuthorization | null> {
    const row = this.db
      .select()
      .from(oauthPendingAuthorizations)
      .where(eq(oauthPendingAuthorizations.id, id))
      .get();
    return row ? rowToPendingAuthorization(row) : null;
  }

  async denyPendingAuthorization(deviceAuthCode: string, nowIso: string): Promise<boolean> {
    const row = this.db
      .update(oauthPendingAuthorizations)
      .set({ status: 'denied' })
      .where(
        and(
          eq(oauthPendingAuthorizations.device_auth_code, deviceAuthCode),
          eq(oauthPendingAuthorizations.status, 'pending'),
          gt(oauthPendingAuthorizations.expires_at, nowIso)
        )
      )
      .returning({ id: oauthPendingAuthorizations.id })
      .get();
    return row !== undefined;
  }

  async expirePendingAuthorization(deviceAuthCode: string, nowIso: string): Promise<boolean> {
    const row = this.db
      .update(oauthPendingAuthorizations)
      .set({ status: 'expired' })
      .where(
        and(
          eq(oauthPendingAuthorizations.device_auth_code, deviceAuthCode),
          eq(oauthPendingAuthorizations.status, 'pending'),
          gt(oauthPendingAuthorizations.expires_at, nowIso)
        )
      )
      .returning({ id: oauthPendingAuthorizations.id })
      .get();
    return row !== undefined;
  }

  async approvePendingAuthorization(
    deviceAuthCode: string,
    identity: { kiloUserId: string; organizationId: string | null },
    nowIso: string
  ): Promise<boolean> {
    const row = this.db
      .update(oauthPendingAuthorizations)
      .set({
        status: 'approved',
        kilo_user_id: identity.kiloUserId,
        organization_id: identity.organizationId,
      })
      .where(
        and(
          eq(oauthPendingAuthorizations.device_auth_code, deviceAuthCode),
          eq(oauthPendingAuthorizations.status, 'pending'),
          gt(oauthPendingAuthorizations.expires_at, nowIso)
        )
      )
      .returning({ id: oauthPendingAuthorizations.id })
      .get();
    return row !== undefined;
  }

  async completePendingAuthorization(id: string, nowIso: string): Promise<boolean> {
    const row = this.db
      .update(oauthPendingAuthorizations)
      .set({ status: 'completed' })
      .where(
        and(
          eq(oauthPendingAuthorizations.id, id),
          eq(oauthPendingAuthorizations.status, 'approved'),
          gt(oauthPendingAuthorizations.expires_at, nowIso)
        )
      )
      .returning({ id: oauthPendingAuthorizations.id })
      .get();
    return row !== undefined;
  }

  async purgeExpired(nowIso: string): Promise<number> {
    this.db
      .delete(oauthRefreshTokenHistory)
      .where(lt(oauthRefreshTokenHistory.expires_at, nowIso))
      .run();
    const expiredPendingAuthorizations = this.db
      .delete(oauthPendingAuthorizations)
      .where(lt(oauthPendingAuthorizations.expires_at, nowIso))
      .returning({ id: oauthPendingAuthorizations.id })
      .all().length;
    return expiredPendingAuthorizations;
  }

  async getRefreshToken(hash: string, nowIso: string) {
    const row = this.db
      .select()
      .from(oauthRefreshTokenHistory)
      .where(
        and(
          eq(oauthRefreshTokenHistory.token_hash, hash),
          gt(oauthRefreshTokenHistory.expires_at, nowIso)
        )
      )
      .get();
    return row ? { userId: row.user_id, grantId: row.grant_id, current: row.current } : null;
  }

  async rememberRefreshToken(
    hash: string,
    parts: RefreshTokenParts,
    expiresAt: string
  ): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      this.db
        .update(oauthRefreshTokenHistory)
        .set({ current: false })
        .where(
          and(
            eq(oauthRefreshTokenHistory.user_id, parts.userId),
            eq(oauthRefreshTokenHistory.grant_id, parts.grantId)
          )
        )
        .run();
      this.db
        .insert(oauthRefreshTokenHistory)
        .values({
          token_hash: hash,
          user_id: parts.userId,
          grant_id: parts.grantId,
          current: true,
          expires_at: expiresAt,
        })
        .onConflictDoUpdate({
          target: oauthRefreshTokenHistory.token_hash,
          set: { current: true, expires_at: expiresAt },
        })
        .run();
    });
  }

  /** One alarm per DO: purge rows past their own expiry, then reschedule. */
  async alarm(): Promise<void> {
    await this.purgeExpired(new Date().toISOString());
    await this.ctx.storage.setAlarm(Date.now() + PURGE_INTERVAL_MS);
  }
}

/** Repo DO convention: a single stub helper so callers never touch the namespace directly. */
export function getKiloMcpOAuthStoreStub(env: Env) {
  const namespace = env.KILO_MCP_OAUTH_STORE;
  if (!namespace) {
    throw new Error(
      'KILO_MCP_OAUTH_STORE is not bound for this worker environment (wrangler.jsonc durable_objects).'
    );
  }
  return namespace.getByName(STORE_INSTANCE_NAME);
}
