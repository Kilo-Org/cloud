import 'server-only';
import { createHmac } from 'node:crypto';
import { headers } from 'next/headers';
import { captureException } from '@sentry/nextjs';
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
import { logExceptInTest } from '@kilocode/web-shared/lib/utils.server';

/**
 * Durable record of a self-service authentication action, success or failure.
 *
 * Every event is written to `auth_audit_logs` and emitted as an
 * `event:"auth_action"` structured log line (Axiom `vercel` dataset). The log
 * line carries the request IP, which the table deliberately does not store.
 *
 * Neither ever holds a token, a secret, or an email address in clear. An email
 * is stored only as {@link authAuditEmailHash}, so attempts on one address
 * correlate without revealing it. `method` and `failureReason` must be stable
 * codes (`google`, `magic_link`, `invalid_code`), never an error message; a
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
  /** The subject's email; hashed here, never stored or logged in clear. */
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

function subjectEmailHash(email: string | null | undefined): string | null {
  if (!email) return null;
  try {
    return authAuditEmailHash(email);
  } catch (error) {
    captureException(error, { tags: { operation: 'auth_audit_email_hash' } });
    return null;
  }
}

export async function recordAuthEvent(
  request: AuthAuditRequest,
  entry: AuthAuditEntry
): Promise<void> {
  const userId = entry.userId ?? null;
  const method = auditCode(entry.method, 'method');
  const failureReason =
    entry.outcome === 'failure' ? auditCode(entry.failureReason, 'failureReason') : null;

  let auditLogId: string | null = null;
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

  try {
    currentSink({
      event: 'auth_action',
      action: entry.action,
      outcome: entry.outcome,
      userId,
      method,
      failureReason,
      auditLogId,
      persisted: auditLogId !== null,
      ip: request.ip,
      route: request.route,
    });
  } catch (error) {
    captureException(error, { tags: { operation: 'auth_action_log' } });
  }
}
