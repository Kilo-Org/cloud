import { z } from 'zod';

import { API_BASE_URL } from '@/lib/config';
import { clearAttestKeyOnRefusal, getAdmission } from '@/lib/auth/admission';
import { ADMISSION_RECOVERY_FAILED } from '@/lib/auth/auth-error-messages';
import {
  type AuthTerminalRoute,
  classifyAuthResponse,
  reportAuthTerminalFailure,
} from '@/lib/auth/auth-response-class';
import {
  ADMISSION_RECOVERY_UNKNOWN_KEY,
  type AdmissionRecoveryHint,
  parseAuthError,
  type PendingLinkOffer,
} from '@/lib/auth/native-auth-contract';
import { buildClientMetadataHeaders } from '@/lib/client-metadata';
import { reportAppAttestPostFailure } from '@/lib/telemetry/app-attest-events';

const stringCodeErrorSchema = z.object({ code: z.string() });

const retryableAssertionBodySchema = z.looseObject({
  admission: z.object({
    platform: z.literal('ios'),
    kind: z.literal('assertion'),
    keyId: z.string().min(1),
  }),
});

/**
 * A token POST that carried Apple proof: the admission field's declared
 * platform, which is what the server verifies. A plain `z.object` strips the
 * payload during the check; an `undefined` admission (a device that cannot
 * attest) and Android's payload both fail it.
 */
const appleProofBodySchema = z.object({
  admission: z.object({ platform: z.literal('ios') }),
});

/**
 * Upper bound on every auth POST. A hung request must reject so the caller's
 * `finally { finishAction(...) }` always clears the busy state; without it a
 * single stuck POST leaves the sign-in control dead for the life of the app.
 */
export const AUTH_REQUEST_TIMEOUT_MS = 15_000;

export type PostAuthFailure = {
  ok: false;
  errorCode: string | undefined;
  ssoOrganizationId: string | undefined;
  /** The sign-in methods a `SIGNUP-STEP-UP` refusal admits, unfiltered. */
  signupMethods?: string[];
  /** The pending link a `DIFFERENT-OAUTH` refusal offers, when the server created one. */
  pendingLink?: PendingLinkOffer;
  /** The HTTP status the route answered with; absent when it never answered. */
  httpStatus?: number;
  /** True for a refusal retrying cannot change (a 401, or a 4xx with no retry guidance). */
  terminal?: boolean;
  /** The server's own back-off from a 429/503 `Retry-After`, when it sent one. */
  retryAfterMs?: number;
};

/** One parsed answer, reported by the caller so a repaired refusal files nothing. */
type AuthAttempt =
  | { ok: true; data: unknown }
  | { ok: false; failure: PostAuthFailure; unknownKeyHint: AdmissionRecoveryHint | undefined };

/**
 * Report a token POST's transport failure, but only when that request carried
 * Apple proof — a proof-less POST (Android, or a browser fallback) is not an
 * App Attest attempt, and a server verdict is reported on the terminal path
 * instead. Called from the transport catches alone, so the admission shape is
 * parsed once and only when this request actually failed.
 */
function reportAppleProofTransportFailure(body: unknown, isTokenRoute: boolean, timedOut: boolean) {
  if (isTokenRoute && appleProofBodySchema.safeParse(body).success) {
    reportAppAttestPostFailure(timedOut ? 'timeout' : 'network');
  }
}

async function sendAuthAttempt(
  path: AuthTerminalRoute,
  body: unknown,
  extraHeaders: Record<string, string> | undefined
): Promise<AuthAttempt> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, AUTH_REQUEST_TIMEOUT_MS);
  try {
    // Built outside the transport catch: a failure to build the headers or to
    // serialize the body is not a transport failure and must not be reported
    // as one.
    const headers = {
      'Content-Type': 'application/json',
      ...buildClientMetadataHeaders(),
      ...extraHeaders,
    };
    const payload = JSON.stringify(body);
    const isTokenRoute = path === '/api/auth/native/token';
    const response = await fetch(`${API_BASE_URL}${path}`, {
      method: 'POST',
      headers,
      body: payload,
      signal: controller.signal,
    }).catch((error: unknown) => {
      // The server never answered. Reported as the App Attest transport step
      // only for a token POST that carried Apple proof; the app's own deadline
      // is `timeout`, every other rejection `network`.
      reportAppleProofTransportFailure(body, isTokenRoute, controller.signal.aborted);
      throw error;
    });

    let json: unknown = undefined;
    try {
      json = await response.json();
    } catch (error) {
      // An abort also lands here when the server sent headers but stalled the
      // body, so a failed parse must not swallow the timeout: rethrow so the
      // outer catch names it TIMEOUT instead of reporting an empty success.
      if (controller.signal.aborted) {
        reportAppleProofTransportFailure(body, isTokenRoute, true);
        throw error;
      }
      json = undefined;
    }

    if (!response.ok) {
      const parsed = parseAuthError(json);
      await clearAttestKeyOnRefusal(parsed?.code);
      const classified = classifyAuthResponse({
        path,
        status: response.status,
        retryAfterHeader: response.headers.get('retry-after'),
      });
      return {
        ok: false,
        failure: {
          ok: false,
          errorCode: parsed?.code,
          ssoOrganizationId: parsed?.ssoOrganizationId,
          signupMethods: parsed?.signupMethods,
          pendingLink: parsed?.pendingLink,
          httpStatus: response.status,
          terminal: classified.kind === 'terminal',
          retryAfterMs: classified.kind === 'retry' ? classified.retryAfterMs : undefined,
        },
        // Only the 403 the route writes for a refused device proof may name a
        // recovery; any other status carrying the field is not repairable here.
        unknownKeyHint:
          response.status === 403 && parsed?.code === 'ADMISSION_REQUIRED'
            ? parsed.recovery
            : undefined,
      };
    }

    return { ok: true, data: json };
  } catch {
    // A real abort is named so the caller can show the timeout copy; any other
    // network failure stays undefined and keeps the generic message. Only a
    // server refusal drops the attest key, so the abort path must not touch it.
    return {
      ok: false,
      failure: {
        ok: false,
        errorCode: controller.signal.aborted ? 'TIMEOUT' : undefined,
        ssoOrganizationId: undefined,
        httpStatus: undefined,
        terminal: false,
        retryAfterMs: undefined,
      },
      unknownKeyHint: undefined,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/** File the one terminal event a refusal earns, when it earns one. */
function reportIfTerminal(path: AuthTerminalRoute, failure: PostAuthFailure): void {
  if (failure.terminal && failure.httpStatus !== undefined) {
    reportAuthTerminalFailure(path, failure.httpStatus);
  }
}

/**
 * Minimal fetch helper for auth endpoints. Returns success with parsed body
 * or failure with an optional error code, SSO organization id, and the
 * classification of the refusal.
 *
 * Every native auth POST routes through here, so this is also where a refused
 * admission drops the stored App Attest key id. Putting it here rather than at
 * each caller means a new sign-in path cannot forget it. A terminal refusal
 * (a 401, or a 4xx with no retry guidance) is classified here and reported
 * once with a stable fingerprint, instead of once per retry. The stored
 * credential is cleared where a stored credential can exist and a 401 proves
 * it dead — the refresh rotation in `credentials.ts`.
 *
 * One refusal is repaired here: the token route's `IOS_ASSERTION_UNKNOWN_KEY`
 * hint, sent only for an iOS assertion against a key id this database has never
 * stored, and only before any provider call, OTP reservation, ticket
 * consumption, or settlement. The request is repeated once with a new
 * attestation, so the retry keeps the caller's provider proof. A retry is never
 * sent without a fresh proof, never repeats the refused key, and never runs a
 * second time.
 *
 * `extraHeaders` carries a caller's own auth header; the login routes take
 * none, and only the authenticated passkey registration route sets it.
 */
export async function postAuth(
  path: AuthTerminalRoute,
  body: unknown,
  extraHeaders?: Record<string, string>
): Promise<{ ok: true; data: unknown } | PostAuthFailure> {
  const attempt = await sendAuthAttempt(path, body, extraHeaders);
  if (attempt.ok) {
    return attempt;
  }

  const parsed =
    path === '/api/auth/native/token' && attempt.unknownKeyHint === ADMISSION_RECOVERY_UNKNOWN_KEY
      ? retryableAssertionBodySchema.safeParse(body)
      : undefined;
  if (!parsed?.success) {
    reportIfTerminal(path, attempt.failure);
    return attempt.failure;
  }

  // The refusal dropped the stored key id, so this is a new attestation against
  // a fresh challenge. Failing to build one is a provider or transport fault,
  // not a device refusal: it stays retryable and reads as the retryable
  // admission message, never the terminal browser-only one. Its own code keeps
  // a failed proof rebuild from reading downstream as a cancelled ceremony.
  const fresh = await getAdmission().catch(() => undefined);
  if (
    fresh?.platform !== 'ios' ||
    fresh.kind !== 'attestation' ||
    !fresh.keyId ||
    fresh.keyId === parsed.data.admission.keyId
  ) {
    // The attempt that got here was a terminal 403; an unrepairable refusal is
    // still the one report that refusal earns.
    reportIfTerminal(path, attempt.failure);
    return {
      ok: false,
      errorCode: ADMISSION_RECOVERY_FAILED,
      ssoOrganizationId: undefined,
      terminal: false,
    };
  }

  const retried = await sendAuthAttempt(path, { ...parsed.data, admission: fresh }, extraHeaders);
  if (!retried.ok) {
    reportIfTerminal(path, retried.failure);
    return retried.failure;
  }
  return retried;
}

export function hasStringCode(error: unknown): error is { code: string } {
  return stringCodeErrorSchema.safeParse(error).success;
}
