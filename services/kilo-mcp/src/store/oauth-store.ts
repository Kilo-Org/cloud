import { DurableObject } from 'cloudflare:workers';
import type { AuthRequest } from '@cloudflare/workers-oauth-provider';
import { and, desc, eq, gt, isNotNull, isNull, lt, notInArray, sql } from 'drizzle-orm';
import { drizzle, type DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import migrations from '../../drizzle/migrations';
import {
  mcpAdminAuthenticators,
  mcpProtectedRequests,
  oauthPendingAuthorizations,
  oauthRefreshTokenHistory,
} from '../db/sqlite-schema';
import type { RefreshReuseStore, RefreshTokenParts } from '../oauth/refresh-reuse';
import { generateAuthenticatorSecret, verifyTotp } from '../otp/totp';
import type { TotpVerification } from '../otp/totp';
import type {
  AuthenticatorEnrollmentApi,
  OtpSubmitOutcome,
  ProtectedRequestKind,
  ProtectedRequestsApi,
} from '../types';

/**
 * KiloMcpOAuthStore — the only hand-rolled OAuth state the library does not own
 * (s2): the short-lived pending-authorization records that bridge GET
 * /authorize to the apps/web device-auth pairing, plus the admin authenticators
 * and the OTP-gated protected requests (o2).
 *
 * The pending records are one logical namespace (any worker instance must see
 * any record), so a single SQLite DO instance (`getByName(STORE_INSTANCE_NAME)`)
 * is the coordination atom. Volume is auth traffic only, not MCP tool calls.
 *
 * Every write carries `nowIso` from the caller so expiry semantics are
 * deterministic under test; the DO never reads the clock for authorization
 * decisions. Rows are structured-clone-safe plain objects.
 *
 * The store never logs a code, a secret, a payload or an identity.
 */

/** Fixed instance name for the single global registry. */
const STORE_INSTANCE_NAME = 'kilo-mcp-oauth';

/** Interval between expired-row purges (DO alarm). */
const PURGE_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Newest refresh-token hashes kept per grant. The provider accepts the current
 * and the immediately previous refresh token, so eight rotations is the margin
 * that keeps both of them — and only a bounded number of older hashes — for
 * the whole session. Without the bound a year of rotations per client would
 * grow this single global DO forever.
 */
const REFRESH_HISTORY_KEEP_PER_GRANT = 8;

/** How long a protected request stays actionable after `call_protected` (o2). */
export const PROTECTED_REQUEST_TTL_SECONDS = 300;

/** Wrong OTP submissions one protected request accepts before it is invalidated (o2). */
export const MAX_OTP_ATTEMPTS = 5;

/**
 * Wrong OTP submissions one authenticator accepts across requests before the
 * gate locks (o2). The per-request cap alone is bypassable: `call_protected`
 * mints a fresh row with `attempts = 0` on demand, so a holder of an opted-in
 * grant could keep guessing. This count lives on the authenticator, so a new
 * request cannot reset it.
 */
export const MAX_OTP_FAILURES = 10;

/** How long an authenticator refuses submissions after `MAX_OTP_FAILURES` (o2). */
export const OTP_LOCKOUT_SECONDS = 15 * 60;

/** ISO timestamp `seconds` after `nowIso`, computed without reading the clock. */
function plusSeconds(nowIso: string, seconds: number): string {
  return new Date(Date.parse(nowIso) + seconds * 1000).toISOString();
}

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
   * approved -> pending after the library's `completeAuthorization` failed:
   * releases the record so the user can retry the picker instead of being
   * stranded on a terminal 'approved'. Guarded on the record still being
   * approved, so a concurrent completion/denial/expiry wins and is left alone.
   * The recorded Kilo pairing is kept, so the retry does not repeat sign-in.
   */
  releasePendingAuthorization(id: string, nowIso: string): Promise<boolean>;
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
  implements OAuthStoreApi, RefreshReuseStore, ProtectedRequestsApi, AuthenticatorEnrollmentApi
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

  async releasePendingAuthorization(id: string, nowIso: string): Promise<boolean> {
    const row = this.db
      .update(oauthPendingAuthorizations)
      .set({ status: 'pending', organization_id: null })
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
    // A protected request's payload goes away with its row; nothing else
    // retains it. Authenticator rows are long-lived and never purged: the
    // recorded single-use step must outlive the requests it guarded.
    this.db.delete(mcpProtectedRequests).where(lt(mcpProtectedRequests.expires_at, nowIso)).run();
    const expiredPendingAuthorizations = this.db
      .delete(oauthPendingAuthorizations)
      .where(lt(oauthPendingAuthorizations.expires_at, nowIso))
      .returning({ id: oauthPendingAuthorizations.id })
      .all().length;
    return expiredPendingAuthorizations;
  }

  /**
   * The admin's authenticator, created on first call. The secret is immutable
   * once stored: `onConflictDoNothing` makes this insert-if-absent, so two
   * concurrent picker renders both read back the one secret the admin already
   * scanned — a re-render must never mint a replacement and strand the app.
   */
  async ensureAuthenticator(
    kiloUserId: string,
    nowIso: string
  ): Promise<{ secret: string; verified: boolean }> {
    this.db
      .insert(mcpAdminAuthenticators)
      .values({
        kilo_user_id: kiloUserId,
        secret: generateAuthenticatorSecret(),
        verified_at: null,
        last_used_step: null,
        failed_attempts: 0,
        locked_until: null,
        created_at: nowIso,
        updated_at: nowIso,
      })
      .onConflictDoNothing({ target: mcpAdminAuthenticators.kilo_user_id })
      .run();
    const row = this.db
      .select()
      .from(mcpAdminAuthenticators)
      .where(eq(mcpAdminAuthenticators.kilo_user_id, kiloUserId))
      .get();
    if (!row) {
      throw new Error('authenticator row missing immediately after insert-if-absent');
    }
    return { secret: row.secret, verified: row.verified_at !== null };
  }

  async confirmAuthenticator(kiloUserId: string, code: string, nowIso: string): Promise<boolean> {
    const row = this.db
      .select()
      .from(mcpAdminAuthenticators)
      .where(eq(mcpAdminAuthenticators.kilo_user_id, kiloUserId))
      .get();
    if (!row) {
      return false;
    }
    const verification = await verifyTotp(row.secret, code, Date.parse(nowIso));
    if (!verification.ok) {
      return false;
    }
    // Deliberately does NOT touch `last_used_step`: an enrollment code must not
    // consume the execution step and lock the admin out of their first approval
    // inside the same 30-second window. The code proved possession here; single
    // use is enforced when `verifyOtpAndClaim` records an execution step.
    this.db
      .update(mcpAdminAuthenticators)
      .set({ verified_at: nowIso, updated_at: nowIso })
      .where(eq(mcpAdminAuthenticators.kilo_user_id, kiloUserId))
      .run();
    return true;
  }

  async createProtectedRequest(input: {
    sessionId: string;
    kiloUserId: string;
    clientId: string;
    path: string;
    kind: ProtectedRequestKind;
    inputJson: string | null;
    nowIso: string;
  }): Promise<{ id: string; expiresAt: string }> {
    const id = crypto.randomUUID();
    const expiresAt = plusSeconds(input.nowIso, PROTECTED_REQUEST_TTL_SECONDS);
    this.db
      .insert(mcpProtectedRequests)
      .values({
        id,
        session_id: input.sessionId,
        kilo_user_id: input.kiloUserId,
        client_id: input.clientId,
        path: input.path,
        kind: input.kind,
        input_json: input.inputJson,
        status: 'pending',
        attempts: 0,
        created_at: input.nowIso,
        expires_at: expiresAt,
      })
      .run();
    return { id, expiresAt };
  }

  async peekProtectedRequest(
    id: string,
    sessionId: string,
    nowIso: string
  ): Promise<
    | { status: 'pending' }
    | { status: 'expired' }
    | { status: 'invalidated' }
    | { status: 'gone' }
    | { status: 'locked'; retryAfterSeconds: number }
  > {
    const row = this.db
      .select()
      .from(mcpProtectedRequests)
      .where(and(eq(mcpProtectedRequests.id, id), eq(mcpProtectedRequests.session_id, sessionId)))
      .get();
    // An unknown id, another session's id and an already-used row answer the
    // uniform `gone`. The owning connection already holds the id, so telling it
    // why its own request is no longer submittable discloses nothing new.
    if (!row || row.status === 'used') {
      return { status: 'gone' };
    }
    // Same order as `claimProtectedRequest`, so a peek and a claim agree on a
    // row that is both cancelled and past its TTL.
    if (row.status === 'invalidated') {
      return { status: 'invalidated' };
    }
    if (row.expires_at <= nowIso) {
      return { status: 'expired' };
    }
    // The account-wide wrong-code lock follows the owner, not the row, so a
    // fresh request cannot sidestep it. Reporting it here lets the handler
    // refuse before it spends an upstream admin re-check on a locked account;
    // `claimProtectedRequest` checks it again for the peek/claim race.
    const lock = this.authenticatorLockState(row.kilo_user_id, nowIso);
    if (lock.locked) {
      return { status: 'locked', retryAfterSeconds: lock.retryAfterSeconds };
    }
    return { status: 'pending' };
  }

  async verifyOtpAndClaim(input: {
    id: string;
    sessionId: string;
    kiloUserId: string;
    code: string;
    nowIso: string;
  }): Promise<OtpSubmitOutcome> {
    // `verifyTotp` is async (WebCrypto) and `transactionSync` cannot await, so
    // the HMAC comparison is computed first. The secret is immutable once
    // enrolled — `ensureAuthenticator` never rewrites it and no other method
    // changes it — so this is the same verification the transaction would
    // perform; every row read and every state change (including the attempt
    // count and the single-use step) still happens inside the transaction.
    // Only a verified row is usable (`verified_at` is the schema's invariant):
    // an authenticator that never proved possession is treated as none at all,
    // so a half-finished enrollment can never approve an execution.
    const authenticator = this.db
      .select({ secret: mcpAdminAuthenticators.secret })
      .from(mcpAdminAuthenticators)
      .where(
        and(
          eq(mcpAdminAuthenticators.kilo_user_id, input.kiloUserId),
          isNotNull(mcpAdminAuthenticators.verified_at)
        )
      )
      .get();
    const verification = authenticator
      ? await verifyTotp(authenticator.secret, input.code, Date.parse(input.nowIso))
      : null;
    return this.ctx.storage.transactionSync(() => this.claimProtectedRequest(input, verification));
  }

  /**
   * The synchronous body of `verifyOtpAndClaim`: resolve the caller's row, apply
   * the attempt accounting and claim the request exactly once. Runs inside one
   * storage transaction, so two submissions can never both claim a row.
   */
  private claimProtectedRequest(
    input: { id: string; sessionId: string; kiloUserId: string; nowIso: string },
    verification: TotpVerification | null
  ): OtpSubmitOutcome {
    const row = this.db
      .select()
      .from(mcpProtectedRequests)
      .where(
        and(
          eq(mcpProtectedRequests.id, input.id),
          eq(mcpProtectedRequests.session_id, input.sessionId)
        )
      )
      .get();
    // An unknown id, another session's id, another admin's id and an
    // already-used row share one uniform refusal that names no path, kind,
    // client or owner: enumerating ids learns nothing.
    if (!row || row.status === 'used' || row.kilo_user_id !== input.kiloUserId) {
      return { status: 'not_pending' };
    }
    // Only the owner reaches the informative answers below; they already hold
    // the id and the row, so nothing new is disclosed.
    if (row.status === 'invalidated') {
      return { status: 'invalidated' };
    }
    if (row.expires_at <= input.nowIso) {
      return { status: 'expired' };
    }
    if (!verification) {
      return { status: 'no_authenticator' };
    }
    // The account-wide wrong-code limiter. `call_protected` can mint fresh
    // requests without bound, so the per-request `attempts` cap alone would let
    // a holder of an opted-in grant keep guessing; this count is on the
    // authenticator and survives a new request. A live lock refuses even a
    // correct code, and an expired lock starts a fresh window.
    const lock = this.authenticatorLockState(input.kiloUserId, input.nowIso);
    if (lock.locked) {
      return { status: 'locked', retryAfterSeconds: lock.retryAfterSeconds };
    }
    // A code from the recorded step or an earlier one is a replay of an
    // already-accepted execution code and must never run a second call.
    if (verification.ok) {
      const lastUsedStep = this.lastUsedStep(input.kiloUserId);
      if (lastUsedStep !== null && verification.step <= lastUsedStep) {
        return { status: 'reused_code' };
      }
    }
    if (!verification.ok) {
      const attempts = row.attempts + 1;
      const invalidated = attempts >= MAX_OTP_ATTEMPTS;
      const failures = lock.failures + 1;
      const lockedOut = failures >= MAX_OTP_FAILURES;
      this.db
        .update(mcpProtectedRequests)
        .set({ attempts, status: invalidated ? 'invalidated' : row.status })
        .where(eq(mcpProtectedRequests.id, row.id))
        .run();
      this.db
        .update(mcpAdminAuthenticators)
        .set({
          failed_attempts: failures,
          locked_until: lockedOut ? plusSeconds(input.nowIso, OTP_LOCKOUT_SECONDS) : null,
          updated_at: input.nowIso,
        })
        .where(eq(mcpAdminAuthenticators.kilo_user_id, input.kiloUserId))
        .run();
      if (lockedOut) {
        return { status: 'locked', retryAfterSeconds: OTP_LOCKOUT_SECONDS };
      }
      return {
        status: 'bad_code',
        // The tighter of the per-request and per-account budgets, so the count
        // the caller sees is never larger than the one that will refuse it.
        attemptsRemaining: Math.max(
          0,
          Math.min(MAX_OTP_ATTEMPTS - attempts, MAX_OTP_FAILURES - failures)
        ),
      };
    }
    // A verified code clears the account-wide failure count: the admin proved
    // possession, so earlier mistypes must not count toward a future lockout.
    this.db
      .update(mcpAdminAuthenticators)
      .set({
        last_used_step: verification.step,
        failed_attempts: 0,
        locked_until: null,
        updated_at: input.nowIso,
      })
      .where(eq(mcpAdminAuthenticators.kilo_user_id, input.kiloUserId))
      .run();
    const claimed = this.db
      .update(mcpProtectedRequests)
      .set({ status: 'used' })
      .where(and(eq(mcpProtectedRequests.id, row.id), eq(mcpProtectedRequests.status, 'pending')))
      .returning({ id: mcpProtectedRequests.id })
      .get();
    if (!claimed) {
      return { status: 'not_pending' };
    }
    return { status: 'ok', path: row.path, inputJson: row.input_json };
  }

  /** The admin's recorded single-use step, or null when none has been accepted. */
  private lastUsedStep(kiloUserId: string): number | null {
    return (
      this.db
        .select({ last_used_step: mcpAdminAuthenticators.last_used_step })
        .from(mcpAdminAuthenticators)
        .where(eq(mcpAdminAuthenticators.kilo_user_id, kiloUserId))
        .get()?.last_used_step ?? null
    );
  }

  /**
   * The authenticator's account-wide wrong-code state at `nowIso`. A
   * `locked_until` still in the future locks the gate; an expired one starts a
   * fresh window with no carried-over failures, so waiting out the lockout is
   * not punished with an immediate re-lock on the next mistype.
   */
  private authenticatorLockState(
    kiloUserId: string,
    nowIso: string
  ): { locked: false; failures: number } | { locked: true; retryAfterSeconds: number } {
    const row = this.db
      .select({
        failed_attempts: mcpAdminAuthenticators.failed_attempts,
        locked_until: mcpAdminAuthenticators.locked_until,
      })
      .from(mcpAdminAuthenticators)
      .where(eq(mcpAdminAuthenticators.kilo_user_id, kiloUserId))
      .get();
    if (row?.locked_until) {
      const remainingMs = Date.parse(row.locked_until) - Date.parse(nowIso);
      if (remainingMs > 0) {
        return { locked: true, retryAfterSeconds: Math.ceil(remainingMs / 1000) };
      }
      return { locked: false, failures: 0 };
    }
    return { locked: false, failures: row?.failed_attempts ?? 0 };
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
      // Every write uses `now + REFRESH_HISTORY_TTL_MS` and the DO's token
      // queue serializes rotations, so ordering by `expires_at` ranks by write
      // time; `rowid` breaks a tie between two writes in the same millisecond
      // by insertion order, which `expires_at` alone cannot, and a LIMIT over
      // that tie could otherwise keep older rows and drop the newest ones.
      // Together they put the row just inserted — and with it the provider's
      // only other accepted token, the previous one — inside the kept set.
      // `notInArray` is never empty: the kept set always contains the row
      // inserted a moment earlier.
      const kept = this.db
        .select({ token_hash: oauthRefreshTokenHistory.token_hash })
        .from(oauthRefreshTokenHistory)
        .where(
          and(
            eq(oauthRefreshTokenHistory.user_id, parts.userId),
            eq(oauthRefreshTokenHistory.grant_id, parts.grantId)
          )
        )
        .orderBy(desc(oauthRefreshTokenHistory.expires_at), desc(sql`rowid`))
        .limit(REFRESH_HISTORY_KEEP_PER_GRANT)
        .all()
        .map(row => row.token_hash);
      this.db
        .delete(oauthRefreshTokenHistory)
        .where(
          and(
            eq(oauthRefreshTokenHistory.user_id, parts.userId),
            eq(oauthRefreshTokenHistory.grant_id, parts.grantId),
            notInArray(oauthRefreshTokenHistory.token_hash, kept)
          )
        )
        .run();
    });
  }

  /**
   * Drop every hash recorded for a grant. The reuse guard calls this after it
   * revokes a grant: a dead grant can never authenticate another replay, so its
   * rows must not sit in the single global DO until the one-year history TTL
   * would have removed them.
   */
  async forgetRefreshTokens(parts: RefreshTokenParts): Promise<void> {
    this.db
      .delete(oauthRefreshTokenHistory)
      .where(
        and(
          eq(oauthRefreshTokenHistory.user_id, parts.userId),
          eq(oauthRefreshTokenHistory.grant_id, parts.grantId)
        )
      )
      .run();
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
