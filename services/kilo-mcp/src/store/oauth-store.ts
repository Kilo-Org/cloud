import { DurableObject } from 'cloudflare:workers';
import { and, count, desc, eq, gt, isNull, lt, notInArray } from 'drizzle-orm';
import { drizzle, type DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import migrations from '../../drizzle/migrations';
import {
  oauthClients,
  oauthCodes,
  oauthRefreshTokens,
  oauthRevokedJtis,
} from '../db/sqlite-schema';

/**
 * KiloMcpOAuthStore — the OAuth 2.1 state for THIS MCP (clients, pairing
 * codes, refresh tokens, revoked access-token jtis) in DO SQLite via Drizzle's
 * query builder. Tracked migration: wrangler.jsonc `migrations` tag v1.
 *
 * The registry is one logical namespace (any worker instance must see any
 * client/code), so a single SQLite DO instance (`getByName(STORE_INSTANCE_NAME)`)
 * is the coordination atom. Volume is auth traffic only (DCR + token exchange),
 * not MCP tool calls.
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

/** Hard cap on retained DCR clients; a full registry refuses new registrations. */
export const MAX_REGISTERED_CLIENTS = 10_000;

/** Aged clients with no live grant are purged, so the registry self-heals. */
export const CLIENT_RETENTION_DAYS = 90;

/**
 * Outcome of `rotateRefreshToken`:
 * - `rotated`: the old token was live; the new one is stored.
 * - `replayed`: the old token existed but a concurrent rotation already revoked
 *   it; the whole grant is revoked in the same call (RFC 9700 §2.2.2).
 * - `missing`: no such token, or it expired.
 */
export type RotateRefreshTokenResult = 'rotated' | 'replayed' | 'missing';

export type StoredClient = {
  clientId: string;
  redirectUris: string[];
  clientName: string;
  createdAt: string;
};

export type NewOAuthClient = {
  clientId: string;
  redirectUris: string[];
  clientName: string;
  createdAt: string;
};

export type OAuthCodeStatus = 'pending' | 'approved' | 'used' | 'denied' | 'expired';

export type OAuthCodeRecord = {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scope: string;
  state: string | null;
  deviceAuthCode: string;
  status: OAuthCodeStatus;
  kiloUserId: string | null;
  organizationId: string | null;
  /**
   * The Kilo API token from the approved device-auth pairing (s6). Set by
   * recordPairingApproval while the code is still 'pending' (the org is not
   * chosen yet); carried onto the refresh-token grant at exchange so /mcp can
   * forward it. Never log it.
   */
  kiloToken: string | null;
  createdAt: string;
  expiresAt: string;
};

export type NewOAuthCode = {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scope: string;
  state: string | null;
  deviceAuthCode: string;
  createdAt: string;
  /** ISO timestamp; the record is exchangeable only until then. */
  expiresAt: string;
};

export type RefreshTokenRecord = {
  id: string;
  tokenHash: string;
  clientId: string;
  kiloUserId: string;
  organizationId: string | null;
  /** The Kilo API token this grant forwards to apps/web (s6). Never log it. */
  kiloToken: string | null;
  resource: string;
  scope: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
};

export type NewRefreshToken = {
  id: string;
  tokenHash: string;
  clientId: string;
  kiloUserId: string;
  organizationId: string | null;
  kiloToken: string | null;
  resource: string;
  scope: string;
  createdAt: string;
  expiresAt: string;
};

/**
 * The RPC surface the auth endpoints depend on. The DurableObjectStub of
 * KiloMcpOAuthStore satisfies it structurally; unit tests pass an in-memory
 * fake. Kept as an interface so handlers never touch the namespace binding.
 */
export interface OAuthStoreApi {
  /** Insert a client; false when the registry is at MAX_REGISTERED_CLIENTS. */
  registerClient(input: NewOAuthClient): Promise<boolean>;
  getClient(clientId: string): Promise<StoredClient | null>;
  createCode(input: NewOAuthCode): Promise<void>;
  getCode(code: string): Promise<OAuthCodeRecord | null>;
  /**
   * Record the approved Kilo pairing while the code is still pending (s6):
   * binds `{ kiloUserId, kiloToken }` without choosing an org. The upstream
   * device-auth poll is single-use, so this write is what stops the status
   * endpoint from ever polling apps/web twice for one pairing. The first
   * writer wins; a second call never overwrites the stored token.
   */
  recordPairingApproval(
    deviceAuthCode: string,
    identity: { kiloUserId: string; kiloToken: string },
    nowIso: string
  ): Promise<boolean>;
  /** pending -> denied after the user denied the Kilo pairing upstream (s6). */
  denyCode(deviceAuthCode: string, nowIso: string): Promise<boolean>;
  /** pending -> expired after apps/web reported the pairing expired upstream. */
  markCodeExpired(deviceAuthCode: string, nowIso: string): Promise<boolean>;
  /** pending -> approved with the Kilo identity; false when not exchangeable-pending. */
  approveCode(
    deviceAuthCode: string,
    identity: { kiloUserId: string; organizationId: string | null },
    nowIso: string
  ): Promise<boolean>;
  /** Atomic single-use exchange: approved -> used. Null when the code is not exchangeable. */
  consumeCode(code: string, nowIso: string): Promise<OAuthCodeRecord | null>;
  saveRefreshToken(input: NewRefreshToken): Promise<void>;
  getRefreshTokenByHash(tokenHash: string): Promise<RefreshTokenRecord | null>;
  /**
   * Atomic rotation: revoke the old token (if still live) and insert the new
   * one. `replayed` means the old token lost a concurrent rotation; the whole
   * grant is revoked in the same call before it returns.
   */
  rotateRefreshToken(
    oldId: string,
    input: NewRefreshToken,
    nowIso: string
  ): Promise<RotateRefreshTokenResult>;
  /**
   * Revoke every live refresh token of one grant — (client, user, org,
   * resource) — in one write. The replay of a rotated-away token is evidence
   * the grant was stolen (RFC 9700 §2.2.2), so the thief's newer rotation must
   * die with the replay. Returns the number of rows revoked.
   */
  revokeGrant(
    grant: {
      clientId: string;
      kiloUserId: string;
      organizationId: string | null;
      resource: string;
    },
    nowIso: string
  ): Promise<number>;
  /**
   * The Kilo API token to forward for a verified MCP identity: the newest live
   * grant for (user, client, org, resource). Null when the user must
   * reconnect. The lookup must be scoped to the token's own grant — a token
   * minted for one org or resource must never forward another grant's
   * credential.
   */
  getKiloToken(
    identity: {
      kiloUserId: string;
      clientId: string;
      organizationId: string | null;
      resource: string;
    },
    nowIso: string
  ): Promise<string | null>;
  revokeJti(jti: string, tokenExpiresAt: string, nowIso: string): Promise<void>;
  isJtiRevoked(jti: string): Promise<boolean>;
  /**
   * Housekeeping: drop rows past their own expiry, plus aged clients with no
   * live grant. Returns the deleted row count.
   */
  purgeExpired(nowIso: string): Promise<number>;
}

function rowToClient(row: typeof oauthClients.$inferSelect): StoredClient {
  return {
    clientId: row.client_id,
    redirectUris: JSON.parse(row.redirect_uris) as string[],
    clientName: row.client_name,
    createdAt: row.created_at,
  };
}

function rowToCode(row: typeof oauthCodes.$inferSelect): OAuthCodeRecord {
  return {
    code: row.code,
    clientId: row.client_id,
    redirectUri: row.redirect_uri,
    codeChallenge: row.code_challenge,
    resource: row.resource,
    scope: row.scope,
    state: row.state,
    deviceAuthCode: row.device_auth_code,
    status: row.status,
    kiloUserId: row.kilo_user_id,
    organizationId: row.organization_id,
    kiloToken: row.kilo_token,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

function rowToRefreshToken(row: typeof oauthRefreshTokens.$inferSelect): RefreshTokenRecord {
  return {
    id: row.id,
    tokenHash: row.token_hash,
    clientId: row.client_id,
    kiloUserId: row.kilo_user_id,
    organizationId: row.organization_id,
    kiloToken: row.kilo_token,
    resource: row.resource,
    scope: row.scope,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

export class KiloMcpOAuthStore extends DurableObject<Env> implements OAuthStoreApi {
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

  async registerClient(input: NewOAuthClient): Promise<boolean> {
    const existing = this.db.select({ total: count() }).from(oauthClients).get();
    if ((existing?.total ?? 0) >= MAX_REGISTERED_CLIENTS) return false;
    this.db
      .insert(oauthClients)
      .values({
        client_id: input.clientId,
        redirect_uris: JSON.stringify(input.redirectUris),
        client_name: input.clientName,
        created_at: input.createdAt,
      })
      .run();
    return true;
  }

  async getClient(clientId: string): Promise<StoredClient | null> {
    const row = this.db
      .select()
      .from(oauthClients)
      .where(eq(oauthClients.client_id, clientId))
      .get();
    return row ? rowToClient(row) : null;
  }

  async createCode(input: NewOAuthCode): Promise<void> {
    this.db
      .insert(oauthCodes)
      .values({
        code: input.code,
        client_id: input.clientId,
        redirect_uri: input.redirectUri,
        code_challenge: input.codeChallenge,
        resource: input.resource,
        scope: input.scope,
        state: input.state,
        device_auth_code: input.deviceAuthCode,
        status: 'pending',
        created_at: input.createdAt,
        expires_at: input.expiresAt,
      })
      .run();
  }

  async getCode(code: string): Promise<OAuthCodeRecord | null> {
    const row = this.db.select().from(oauthCodes).where(eq(oauthCodes.code, code)).get();
    return row ? rowToCode(row) : null;
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
      .update(oauthCodes)
      .set({ kilo_user_id: identity.kiloUserId, kilo_token: identity.kiloToken })
      .where(
        and(
          eq(oauthCodes.device_auth_code, deviceAuthCode),
          eq(oauthCodes.status, 'pending'),
          isNull(oauthCodes.kilo_user_id),
          gt(oauthCodes.expires_at, nowIso)
        )
      )
      .returning({ code: oauthCodes.code })
      .get();
    return row !== undefined;
  }

  async denyCode(deviceAuthCode: string, nowIso: string): Promise<boolean> {
    const row = this.db
      .update(oauthCodes)
      .set({ status: 'denied' })
      .where(
        and(
          eq(oauthCodes.device_auth_code, deviceAuthCode),
          eq(oauthCodes.status, 'pending'),
          gt(oauthCodes.expires_at, nowIso)
        )
      )
      .returning({ code: oauthCodes.code })
      .get();
    return row !== undefined;
  }

  async markCodeExpired(deviceAuthCode: string, nowIso: string): Promise<boolean> {
    const row = this.db
      .update(oauthCodes)
      .set({ status: 'expired' })
      .where(
        and(
          eq(oauthCodes.device_auth_code, deviceAuthCode),
          eq(oauthCodes.status, 'pending'),
          gt(oauthCodes.expires_at, nowIso)
        )
      )
      .returning({ code: oauthCodes.code })
      .get();
    return row !== undefined;
  }

  async approveCode(
    deviceAuthCode: string,
    identity: { kiloUserId: string; organizationId: string | null },
    nowIso: string
  ): Promise<boolean> {
    const row = this.db
      .update(oauthCodes)
      .set({
        status: 'approved',
        kilo_user_id: identity.kiloUserId,
        organization_id: identity.organizationId,
      })
      .where(
        and(
          eq(oauthCodes.device_auth_code, deviceAuthCode),
          eq(oauthCodes.status, 'pending'),
          gt(oauthCodes.expires_at, nowIso)
        )
      )
      .returning({ code: oauthCodes.code })
      .get();
    return row !== undefined;
  }

  async consumeCode(code: string, nowIso: string): Promise<OAuthCodeRecord | null> {
    const row = this.db
      .update(oauthCodes)
      .set({ status: 'used' })
      .where(
        and(
          eq(oauthCodes.code, code),
          eq(oauthCodes.status, 'approved'),
          gt(oauthCodes.expires_at, nowIso)
        )
      )
      .returning()
      .get();
    return row ? rowToCode(row) : null;
  }

  async saveRefreshToken(input: NewRefreshToken): Promise<void> {
    this.db
      .insert(oauthRefreshTokens)
      .values({
        id: input.id,
        token_hash: input.tokenHash,
        client_id: input.clientId,
        kilo_user_id: input.kiloUserId,
        organization_id: input.organizationId,
        kilo_token: input.kiloToken,
        resource: input.resource,
        scope: input.scope,
        created_at: input.createdAt,
        expires_at: input.expiresAt,
      })
      .run();
  }

  async getRefreshTokenByHash(tokenHash: string): Promise<RefreshTokenRecord | null> {
    const row = this.db
      .select()
      .from(oauthRefreshTokens)
      .where(eq(oauthRefreshTokens.token_hash, tokenHash))
      .get();
    return row ? rowToRefreshToken(row) : null;
  }

  async rotateRefreshToken(
    oldId: string,
    input: NewRefreshToken,
    nowIso: string
  ): Promise<RotateRefreshTokenResult> {
    const revoked = this.db
      .update(oauthRefreshTokens)
      .set({ revoked_at: nowIso })
      .where(
        and(
          eq(oauthRefreshTokens.id, oldId),
          isNull(oauthRefreshTokens.revoked_at),
          gt(oauthRefreshTokens.expires_at, nowIso)
        )
      )
      .returning({ id: oauthRefreshTokens.id })
      .get();
    if (revoked === undefined) {
      const existing = this.db
        .select()
        .from(oauthRefreshTokens)
        .where(eq(oauthRefreshTokens.id, oldId))
        .get();
      if (existing && existing.revoked_at !== null) {
        // Losing a concurrent rotation is replay evidence (RFC 9700 §2.2.2):
        // revoke the winner's replacement in this same atomic call.
        await this.revokeGrant(
          {
            clientId: existing.client_id,
            kiloUserId: existing.kilo_user_id,
            organizationId: existing.organization_id,
            resource: existing.resource,
          },
          nowIso
        );
        return 'replayed';
      }
      return 'missing';
    }
    this.db
      .insert(oauthRefreshTokens)
      .values({
        id: input.id,
        token_hash: input.tokenHash,
        client_id: input.clientId,
        kilo_user_id: input.kiloUserId,
        organization_id: input.organizationId,
        kilo_token: input.kiloToken,
        resource: input.resource,
        scope: input.scope,
        created_at: input.createdAt,
        expires_at: input.expiresAt,
      })
      .run();
    return 'rotated';
  }

  async revokeGrant(
    grant: {
      clientId: string;
      kiloUserId: string;
      organizationId: string | null;
      resource: string;
    },
    nowIso: string
  ): Promise<number> {
    const rows = this.db
      .update(oauthRefreshTokens)
      .set({ revoked_at: nowIso })
      .where(
        and(
          eq(oauthRefreshTokens.client_id, grant.clientId),
          eq(oauthRefreshTokens.kilo_user_id, grant.kiloUserId),
          eq(oauthRefreshTokens.resource, grant.resource),
          // organization_id is nullable; a null-org grant matches only its own rows.
          grant.organizationId === null
            ? isNull(oauthRefreshTokens.organization_id)
            : eq(oauthRefreshTokens.organization_id, grant.organizationId),
          isNull(oauthRefreshTokens.revoked_at),
          gt(oauthRefreshTokens.expires_at, nowIso)
        )
      )
      .returning({ id: oauthRefreshTokens.id })
      .all();
    return rows.length;
  }

  async getKiloToken(
    identity: {
      kiloUserId: string;
      clientId: string;
      organizationId: string | null;
      resource: string;
    },
    nowIso: string
  ): Promise<string | null> {
    const row = this.db
      .select({ kiloToken: oauthRefreshTokens.kilo_token })
      .from(oauthRefreshTokens)
      .where(
        and(
          eq(oauthRefreshTokens.kilo_user_id, identity.kiloUserId),
          eq(oauthRefreshTokens.client_id, identity.clientId),
          eq(oauthRefreshTokens.resource, identity.resource),
          // organization_id is nullable; a null-org identity matches only null rows.
          identity.organizationId === null
            ? isNull(oauthRefreshTokens.organization_id)
            : eq(oauthRefreshTokens.organization_id, identity.organizationId),
          isNull(oauthRefreshTokens.revoked_at),
          gt(oauthRefreshTokens.expires_at, nowIso)
        )
      )
      .orderBy(desc(oauthRefreshTokens.created_at))
      .limit(1)
      .get();
    return row?.kiloToken ?? null;
  }

  async revokeJti(jti: string, tokenExpiresAt: string, nowIso: string): Promise<void> {
    this.db
      .insert(oauthRevokedJtis)
      .values({ jti, expires_at: tokenExpiresAt, revoked_at: nowIso })
      .onConflictDoNothing()
      .run();
  }

  async isJtiRevoked(jti: string): Promise<boolean> {
    const row = this.db
      .select({ jti: oauthRevokedJtis.jti })
      .from(oauthRevokedJtis)
      .where(eq(oauthRevokedJtis.jti, jti))
      .get();
    return row !== undefined;
  }

  async purgeExpired(nowIso: string): Promise<number> {
    const expiredCodes = this.db
      .delete(oauthCodes)
      .where(lt(oauthCodes.expires_at, nowIso))
      .returning({ code: oauthCodes.code })
      .all().length;
    const expiredRefreshTokens = this.db
      .delete(oauthRefreshTokens)
      .where(lt(oauthRefreshTokens.expires_at, nowIso))
      .returning({ id: oauthRefreshTokens.id })
      .all().length;
    const expiredJtis = this.db
      .delete(oauthRevokedJtis)
      .where(lt(oauthRevokedJtis.expires_at, nowIso))
      .returning({ jti: oauthRevokedJtis.jti })
      .all().length;
    const liveClientIds = this.db
      .select({ clientId: oauthRefreshTokens.client_id })
      .from(oauthRefreshTokens)
      .where(and(isNull(oauthRefreshTokens.revoked_at), gt(oauthRefreshTokens.expires_at, nowIso)));
    const clientCutoff = new Date(
      Date.parse(nowIso) - CLIENT_RETENTION_DAYS * 24 * 60 * 60 * 1000
    ).toISOString();
    const expiredClients = this.db
      .delete(oauthClients)
      .where(
        and(
          lt(oauthClients.created_at, clientCutoff),
          notInArray(oauthClients.client_id, liveClientIds)
        )
      )
      .returning({ clientId: oauthClients.client_id })
      .all().length;
    return expiredCodes + expiredRefreshTokens + expiredJtis + expiredClients;
  }

  /** One alarm per DO: purge rows past their own expiry, then reschedule. */
  async alarm(): Promise<void> {
    await this.purgeExpired(new Date().toISOString());
    await this.ctx.storage.setAlarm(Date.now() + PURGE_INTERVAL_MS);
  }
}

/** Repo DO convention: a single stub helper so callers never touch the namespace directly. */
export function getKiloMcpOAuthStoreStub(env: Env): OAuthStoreApi {
  const namespace = env.KILO_MCP_OAUTH_STORE;
  if (!namespace) {
    throw new Error(
      'KILO_MCP_OAUTH_STORE is not bound for this worker environment (wrangler.jsonc durable_objects).'
    );
  }
  return namespace.getByName(STORE_INSTANCE_NAME);
}
