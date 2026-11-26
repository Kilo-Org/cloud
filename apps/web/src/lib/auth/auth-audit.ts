import 'server-only';
import { createHmac } from 'node:crypto';
import { headers } from 'next/headers';
import { captureException } from '@sentry/nextjs';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';
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

/**
 * Durable record of a self-service authentication action, success or failure.
 *
 * Every event is emitted as an `event:"auth_action"` structured log line
 * (Axiom `vercel` dataset), which carries the request IP the table
 * deliberately does not store. Every success is also written to
 * `auth_audit_logs`; a failure is written there only when it names a subject
 * (a user id or an email) and was not refused by a rate limit or cap
 * (design section 10 item 6, Q56). Any other failure is the log line alone,
 * flagged `stored:false`, so an unauthenticated flood cannot grow the table.
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
 * Recording never throws. A failed insert is reported and flagged with
 * `persisted:false` in the log line.
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

/**
 * Keyed hash of the normalized address (HMAC-SHA256 under NEXTAUTH_SECRET,
 * base64url). The key defeats dictionary reversal of the stored hash; the
 * domain prefix keeps it distinct from other hashes under the same key.
 */
export function authAuditEmailHash(email: string): string {
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
 * Lockouts by too many wrong codes, in audit form. A route answers each with
 * a 429, but each is a security event on a known account that the table keeps
 * (design section 10 item 6: one failure row per locked code), so the 429
 * rule below does not apply to them. `email_code_locked` is the passkey
 * enrollment code (`passkey/register`); `sign_in_method_code_locked` is the
 * sign-in method change code (`pending-link/complete` and the device-auth
 * `pendingLinkCodeLocked` refusal of `device-auth/tokens`).
 */
const LOCKOUT_FAILURE_CODES: Record<string, true> = {
  email_code_locked: true,
  sign_in_method_code_locked: true,
};

/**
 * Runs a route handler as one auth attempt. A response below 400 is a success;
 * a refused response records the code in its `error` field, or `http_<status>`
 * when it carries none. A 429 is a rate-limit refusal whatever its code, so it
 * is the log line only, except for a code lockout ({@link LOCKOUT_FAILURE_CODES}).
 * A throw records `internal_error` and rethrows.
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
  const rateLimited =
    response.status === 429 &&
    (failureReason === null || LOCKOUT_FAILURE_CODES[failureReason] !== true);
  await recordAttemptOutcome(request, attempt, failureReason, rateLimited);
  return response;
}

/**
 * Runs a tRPC resolver body as one auth attempt. A throw records
 * {@link authAuditErrorCode} of the error and rethrows it unchanged.
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
    await recordAttemptOutcome(
      request,
      attempt,
      attempt.failureReason ?? authAuditErrorCode(error)
    );
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
 * Whether an entry belongs in the table: every success; a failure with a
 * subject that no limit refused. `rateLimited` marks a refusal a limit
 * answered whatever its code, such as a 429 response.
 */
function isStoredEntry(
  entry: AuthAuditEntry,
  failureReason: string | null,
  rateLimited: boolean
): boolean {
  if (entry.outcome === 'success') return true;
  if (rateLimited || (!entry.userId && !entry.email)) return false;
  return failureReason === null || RATE_LIMIT_FAILURE_CODES[failureReason] !== true;
}

export async function recordAuthEvent(
  request: AuthAuditRequest,
  entry: AuthAuditEntry
): Promise<void> {
  await writeAuthEvent(request, entry, false);
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

  let auditLogId: string | null = null;
  if (stored) {
    try {
      const [row] = await db
        .insert(auth_audit_logs)
        .values({
          action: entry.action,
          outcome: entry.outcome,
          user_id: userId,
          method,
          failure_reason: failureReason,
          subject_email_hash: subjectEmailHash(entry.email),
          metadata: entry.metadata ?? null,
        })
        .returning({ id: auth_audit_logs.id });
      auditLogId = row?.id ?? null;
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
}
