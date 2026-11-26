import 'server-only';
import { createHmac } from 'node:crypto';
import { headers } from 'next/headers';
import { captureException } from '@sentry/nextjs';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import { sql } from 'drizzle-orm';
import { auth_audit_logs } from '@kilocode/db/schema';
import type { AuthAuditAction, AuthAuditOutcome } from '@kilocode/db/schema-types';
import {
  clientIpFromHeaders,
  routeFromHeaders,
} from '@kilocode/web-shared/lib/admin/admin-access-log';
import { NEXTAUTH_SECRET } from '@kilocode/web-shared/lib/config.server';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { normalizeEmail } from '@kilocode/web-shared/lib/email-address';
import { UpstreamApiError } from '@kilocode/web-shared/lib/trpc/transport';
import { logExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import { runAfterResponse } from '@/lib/after-response';

/**
 * Durable record of a self-service authentication action, success or failure.
 *
 * Every event is emitted as an `event:"auth_action"` structured log line
 * (Axiom `vercel` dataset), which carries the request IP the table
 * deliberately does not store. The table `auth_audit_logs` keeps only events
 * that name a subject (a user id or an email): every such success, and every
 * such failure that no rate limit or cap refused. A code lockout is stored
 * once, for the wrong code that locked the account (design section 10 item 6,
 * Q56). Any other event is the log line alone, flagged `stored:false`, so an
 * unauthenticated flood cannot grow the table.
 *
 * Neither ever holds a token, a secret, or an email address in clear. An email
 * is stored only as {@link authAuditEmailHash}, so attempts on one address
 * correlate without revealing it. Once the attempt has resolved an account,
 * the hash is of that account's `google_user_email`, never of a provider
 * identity's address or the address the person presented; only a refusal that
 * resolved no account hashes the presented address. `method` and
 * `failureReason` must be stable codes (`google`, `magic_link`,
 * `invalid_code`), never an error message; a
 * value that is not a code is replaced with `invalid_code_value` and reported.
 * `metadata` is stored verbatim: safe ids and counts only.
 *
 * Recording never throws and never holds the response: the insert and the log
 * line run after the response is sent ({@link runAfterResponse}; inline in
 * automated tests), and the insert is cancelled after
 * {@link INSERT_STATEMENT_TIMEOUT_MS}. A failed or cancelled insert is
 * reported and flagged with `persisted:false` in the log line.
 */

type AuthAuditEntryFields = {
  action: AuthAuditAction;
  /** The subject account, when known. */
  userId?: string | null;
  /** Sign-in method, provider, or channel, e.g. `google`, `passkey`, `device_auth`. */
  method?: string | null;
  /**
   * The resolved account's `google_user_email`; the presented address only for
   * a refusal that resolved no account. Hashed here, never stored or logged in
   * clear.
   */
  email?: string | null;
  metadata?: Record<string, unknown>;
};

export type AuthAuditEntry = AuthAuditEntryFields &
  ({ outcome: 'success' } | { outcome: 'failure'; failureReason: string });

/** Request attribution for the log line. */
export type AuthAuditRequest = {
  ip: string | null;
  route: string | null;
};

export type AuthActionEvent = {
  event: 'auth_action';
  action: AuthAuditAction;
  outcome: AuthAuditOutcome;
  userId: string | null;
  method: string | null;
  failureReason: string | null;
  auditLogId: string | null;
  /** Whether the event belongs in the table; false for a failure the line alone records. */
  stored: boolean;
  /** Whether the row was written; false when it is not stored or the insert failed. */
  persisted: boolean;
  ip: string | null;
  route: string | null;
};

export type AuthActionSink = (event: AuthActionEvent) => void;

const defaultSink: AuthActionSink = event => logExceptInTest(JSON.stringify(event));

let currentSink: AuthActionSink = defaultSink;

/** Test-only seam; pass `null` to restore the production sink. */
export function setAuthActionSinkForTest(sink: AuthActionSink | null): void {
  currentSink = sink ?? defaultSink;
}

/** Attribution for a route handler, with the same IP derivation as the admin log line. */
export function authAuditRequestFromHeaders(
  headersList: Headers,
  route?: string
): AuthAuditRequest {
  return {
    ip: clientIpFromHeaders(headersList),
    route: route ?? routeFromHeaders(headersList),
  };
}

/** Attribution for a tRPC procedure, from the fields `createTRPCContext` and `baseProcedure` set. */
export function authAuditRequestFromTrpc(ctx: {
  ip?: string | null;
  trpcPath?: string;
}): AuthAuditRequest {
  return { ip: ctx.ip ?? null, route: ctx.trpcPath ?? null };
}

/**
 * Attribution for code that runs in a request but has no headers in hand,
 * such as a NextAuth callback. Outside a request scope it attributes nothing.
 */
export async function authAuditRequestFromCurrentRequest(): Promise<AuthAuditRequest> {
  try {
    return authAuditRequestFromHeaders(await headers());
  } catch {
    return { ip: null, route: null };
  }
}

const EMAIL_HASH_DOMAIN = 'auth-audit-email:v1:';

let reportedMissingHashKey = false;

/**
 * Keyed hash of the normalized address (HMAC-SHA256 under NEXTAUTH_SECRET,
 * base64url). The key defeats dictionary reversal of the stored hash; the
 * domain prefix keeps it distinct from other hashes under the same key.
 *
 * Null when NEXTAUTH_SECRET is empty: an unkeyed hash of an address can be
 * reversed by hashing candidate addresses, so none is made. The
 * misconfiguration is reported once per process.
 */
export function authAuditEmailHash(email: string): string | null {
  if (!NEXTAUTH_SECRET) {
    if (!reportedMissingHashKey) {
      reportedMissingHashKey = true;
      captureException(new Error('auth audit email hash key NEXTAUTH_SECRET is empty'), {
        tags: { operation: 'auth_audit_email_hash_key' },
      });
    }
    return null;
  }
  return createHmac('sha256', NEXTAUTH_SECRET)
    .update(`${EMAIL_HASH_DOMAIN}${normalizeEmail(email)}`)
    .digest('base64url');
}

const AuditCode = z.string().regex(/^[a-z0-9][a-z0-9_.:-]{0,63}$/);

const INVALID_CODE = 'invalid_code_value';

function auditCode(value: string | null | undefined, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (AuditCode.safeParse(value).success) return value;
  // The value itself is not reported: a rejected value may be a message
  // carrying user data.
  captureException(new Error(`auth audit ${field} is not a stable code`), {
    tags: { operation: 'auth_audit_code' },
  });
  return INVALID_CODE;
}

/**
 * A refusal code in audit form: lower case with `_` for `-`, so the
 * `SIGNUP-STEP-UP` redirect code and the `INVALID_TOKEN` response code read
 * as `signup_step_up` and `invalid_token`. Null when the value is not a code,
 * such as a sentence meant for a person.
 */
export function authAuditCode(value: string): string | null {
  const code = value.trim().toLowerCase().replaceAll('-', '_');
  return AuditCode.safeParse(code).success ? code : null;
}

/**
 * The failure code of a thrown error. A tRPC refusal names its client-facing
 * code as its `UpstreamApiError` cause or, for a few refusals, as a message
 * that is itself a code (`PASSKEY_MANAGEMENT_REQUIRED`); any other tRPC error
 * records its tRPC code. Every other error is `internal_error`.
 */
export function authAuditErrorCode(error: unknown): string {
  if (!(error instanceof TRPCError)) return 'internal_error';
  if (error.cause instanceof UpstreamApiError) {
    const upstream = authAuditCode(error.cause.upstreamCode);
    if (upstream) return upstream;
  }
  if (/^[A-Z][A-Z0-9_]+$/.test(error.message)) return error.message.toLowerCase();
  return error.code.toLowerCase();
}

/** The `error` code a refused JSON response carries, else `http_<status>`. */
async function responseFailureCode(response: Response): Promise<string> {
  try {
    const body: unknown = await response.clone().json();
    if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string') {
      const code = authAuditCode(body.error);
      if (code) return code;
    }
  } catch {
    // A response without a JSON body names no code.
  }
  return `http_${response.status}`;
}

function subjectEmailHash(email: string | null | undefined): string | null {
  if (!email) return null;
  try {
    return authAuditEmailHash(email);
  } catch (error) {
    captureException(error, { tags: { operation: 'auth_audit_email_hash' } });
    return null;
  }
}

/**
 * One auth attempt that {@link auditAuthRoute} or {@link auditAuthProcedure}
 * records when it ends. The handler fills in the subject as it learns it.
 */
export type AuthAuditAttempt = AuthAuditEntryFields & {
  /**
   * The attempt failed with this code, whatever the response or error says.
   * Set it where the response carries no code, or where the attempt failed
   * although the caller is answered as if it succeeded.
   */
  failureReason?: string;
  /**
   * The outcome is not a success this wrapper records: a pending poll, or a
   * success another writer records (`recordSignInMethodChange`).
   */
  skipSuccessRow?: boolean;
  /**
   * This refusal is the wrong code that locked the account. It is stored
   * although the caller is answered with a 429; every later refusal while the
   * lock lasts is a 429 like any other, so the log line alone records it.
   */
  lockout?: boolean;
};

function attemptFields(attempt: AuthAuditAttempt): AuthAuditEntryFields {
  return {
    action: attempt.action,
    userId: attempt.userId,
    method: attempt.method,
    email: attempt.email,
    metadata: attempt.metadata,
  };
}

async function recordAttemptOutcome(
  request: AuthAuditRequest,
  attempt: AuthAuditAttempt,
  failureReason: string | null,
  rateLimited = false
): Promise<void> {
  if (failureReason !== null) {
    await writeAuthEvent(
      request,
      { ...attemptFields(attempt), outcome: 'failure', failureReason },
      rateLimited
    );
  } else if (!attempt.skipSuccessRow) {
    await writeAuthEvent(request, { ...attemptFields(attempt), outcome: 'success' }, false);
  }
}

/**
 * Lockout refusals by too many wrong codes, in audit form: `email_code_locked`
 * is the passkey enrollment code (`passkey/register`),
 * `sign_in_method_code_locked` the sign-in method change code
 * (`pending-link/complete`, the device-auth `pendingLinkCodeLocked` refusal of
 * `device-auth/tokens`, and the link and unlink procedures). A route answers
 * each with a 429. Only the attempt that locked the account is stored (it sets
 * {@link AuthAuditAttempt.lockout}); a refusal while the account stays locked
 * is the log line only, so the table holds one lockout row per lock window
 * however often the locked code is tried.
 */
const LOCKOUT_FAILURE_CODES: Record<string, true> = {
  email_code_locked: true,
  sign_in_method_code_locked: true,
};

const lockoutErrors = new WeakSet<object>();

/**
 * Marks a thrown refusal as the wrong code that locked the account, for a
 * caller that refuses by throwing: {@link auditAuthProcedure} stores it, and a
 * route that turns it into a response sets {@link AuthAuditAttempt.lockout}
 * from {@link isAuthAuditLockout}. Returns the error, to be thrown.
 */
export function markAuthAuditLockout<E extends Error>(error: E): E {
  lockoutErrors.add(error);
  return error;
}

export function isAuthAuditLockout(error: unknown): boolean {
  return error instanceof Error && lockoutErrors.has(error);
}

/**
 * Whether a refusal was answered by a limit, so the log line alone records it:
 * a 429 or `TOO_MANY_REQUESTS` whatever its code, or a lockout code, unless the
 * refusal is the one that locked the account.
 */
function refusedByLimit(
  lockout: boolean,
  failureReason: string | null,
  limitAnswered: boolean
): boolean {
  if (lockout) return false;
  return limitAnswered || (failureReason !== null && LOCKOUT_FAILURE_CODES[failureReason] === true);
}

/**
 * Runs a route handler as one auth attempt. A response below 400 is a success;
 * a refused response records the code in its `error` field, or `http_<status>`
 * when it carries none. A 429 is a rate-limit refusal whatever its code, so it
 * is the log line only, except the wrong code that locked the account
 * ({@link AuthAuditAttempt.lockout}). A throw records `internal_error` and
 * rethrows.
 */
export async function auditAuthRoute(
  request: AuthAuditRequest,
  attempt: AuthAuditAttempt,
  run: () => Promise<Response>
): Promise<Response> {
  let response: Response;
  try {
    response = await run();
  } catch (error) {
    await recordAttemptOutcome(request, attempt, attempt.failureReason ?? 'internal_error');
    throw error;
  }
  const failureReason =
    attempt.failureReason ?? (response.status >= 400 ? await responseFailureCode(response) : null);
  const rateLimited = refusedByLimit(
    attempt.lockout === true,
    failureReason,
    response.status === 429
  );
  await recordAttemptOutcome(request, attempt, failureReason, rateLimited);
  return response;
}

/**
 * Runs a tRPC resolver body as one auth attempt. A throw records
 * {@link authAuditErrorCode} of the error and rethrows it unchanged; a
 * `TOO_MANY_REQUESTS` refusal is the log line only, as a 429 is for a route.
 */
export async function auditAuthProcedure<T>(
  ctx: { ip?: string | null; trpcPath?: string },
  attempt: AuthAuditAttempt,
  run: () => Promise<T>
): Promise<T> {
  const request = authAuditRequestFromTrpc(ctx);
  let result: T;
  try {
    result = await run();
  } catch (error) {
    const failureReason = attempt.failureReason ?? authAuditErrorCode(error);
    const rateLimited = refusedByLimit(
      attempt.lockout === true || isAuthAuditLockout(error),
      failureReason,
      error instanceof TRPCError && error.code === 'TOO_MANY_REQUESTS'
    );
    await recordAttemptOutcome(request, attempt, failureReason, rateLimited);
    throw error;
  }
  await recordAttemptOutcome(request, attempt, attempt.failureReason ?? null);
  return result;
}

/**
 * Refusals by a rate limit or cap, in audit form. Each is one more request
 * than a limit allows, so a row per refusal would let a flood fill the table.
 * `rate_limited` covers the firewall rules and the device-auth pending cap;
 * `http_429` is a 429 that names no code.
 */
const RATE_LIMIT_FAILURE_CODES: Record<string, true> = {
  rate_limited: true,
  signup_rate_limited: true,
  too_many_attempts: true,
  too_many_challenges: true,
  too_many_codes: true,
  too_many_requests: true,
  email_code_cooldown: true,
  email_code_hourly_limit: true,
  http_429: true,
};

/**
 * Whether an entry belongs in the table: an event that names a subject, and
 * for a failure, one no limit refused. An event with no subject, such as a
 * device pairing created or cancelled by the device before anyone approved it,
 * names nothing to attribute it to. `rateLimited` marks a refusal a limit
 * answered whatever its code, such as a 429 response.
 */
function isStoredEntry(
  entry: AuthAuditEntry,
  failureReason: string | null,
  rateLimited: boolean
): boolean {
  if (!entry.userId && !entry.email) return false;
  if (entry.outcome === 'success') return true;
  if (rateLimited) return false;
  return failureReason === null || RATE_LIMIT_FAILURE_CODES[failureReason] !== true;
}

export async function recordAuthEvent(
  request: AuthAuditRequest,
  entry: AuthAuditEntry
): Promise<void> {
  await writeAuthEvent(request, entry, false);
}

// A blocked or slow audit table holds a pooled connection for at most this
// long per event, never until the platform's request deadline.
const INSERT_STATEMENT_TIMEOUT_MS = 3_000;

async function insertAuthAuditRow(
  values: typeof auth_audit_logs.$inferInsert
): Promise<string | null> {
  return db.transaction(async tx => {
    // PostgreSQL rejects a parameterized SET; the value is a constant.
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${INSERT_STATEMENT_TIMEOUT_MS}'`));
    const [row] = await tx
      .insert(auth_audit_logs)
      .values(values)
      .returning({ id: auth_audit_logs.id });
    return row?.id ?? null;
  });
}

async function writeAuthEvent(
  request: AuthAuditRequest,
  entry: AuthAuditEntry,
  rateLimited: boolean
): Promise<void> {
  const userId = entry.userId ?? null;
  const method = auditCode(entry.method, 'method');
  const failureReason =
    entry.outcome === 'failure' ? auditCode(entry.failureReason, 'failureReason') : null;
  const stored = isStoredEntry(entry, failureReason, rateLimited);
  const row = stored
    ? {
        action: entry.action,
        outcome: entry.outcome,
        user_id: userId,
        method,
        failure_reason: failureReason,
        subject_email_hash: subjectEmailHash(entry.email),
        metadata: entry.metadata ?? null,
      }
    : null;

  await runAfterResponse(async () => {
    let auditLogId: string | null = null;
    if (row) {
      try {
        auditLogId = await insertAuthAuditRow(row);
      } catch (error) {
        captureException(error, {
          tags: { operation: 'auth_audit_insert' },
          extra: { action: entry.action },
        });
      }
    }

    try {
      currentSink({
        event: 'auth_action',
        action: entry.action,
        outcome: entry.outcome,
        userId,
        method,
        failureReason,
        auditLogId,
        stored,
        persisted: auditLogId !== null,
        ip: request.ip,
        route: request.route,
      });
    } catch (error) {
      captureException(error, { tags: { operation: 'auth_action_log' } });
    }
  });
}
