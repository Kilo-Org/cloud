import 'server-only';
import { TRPCError } from '@trpc/server';
import { CONTROL_PLANE_UPSTREAM_BUDGET_MS } from '@/lib/bounded-service-fetch';
import { INTERNAL_API_SECRET } from '@kilocode/web-shared/lib/config.server';

/** Security Worker called through this module; used in the client-facing message. */
export type SecurityWorkerService = 'sync' | 'dismissal' | 'analysis' | 'remediation';

/**
 * Stable marker for a Worker this process provably never reached. Mobile maps
 * the exact string onto catalog copy (`securityAgent.mutations.serviceUnavailable`),
 * so it must stay a constant rather than a template.
 */
export const SECURITY_SERVICE_UNAVAILABLE_MESSAGE = 'Security service is unavailable';

/**
 * Node/undici codes raised while establishing a connection. Each one means no
 * byte of the request was delivered, so the Worker cannot have accepted it.
 * Anything else — a stalled body, a connect timeout, a reset after the request
 * was sent, TLS, a gateway HTML page — can be delivered, and stays ambiguous.
 */
const PRE_DELIVERY_ERROR_CODES: Record<string, true> = {
  ECONNREFUSED: true,
  ENOTFOUND: true,
  EAI_AGAIN: true,
  EHOSTUNREACH: true,
  ENETUNREACH: true,
};

function collectErrorCodes(error: unknown, codes: Set<string>, seen: Set<unknown>): void {
  if (error === null || typeof error !== 'object' || seen.has(error)) return;
  seen.add(error);
  const { code, errors, cause } = error as {
    code?: unknown;
    errors?: unknown;
    cause?: unknown;
  };
  if (typeof code === 'string') codes.add(code);
  if (Array.isArray(errors)) {
    for (const nested of errors) collectErrorCodes(nested, codes, seen);
  }
  collectErrorCodes(cause, codes, seen);
}

/**
 * True only when every failure observed while connecting is a pre-delivery one
 * and at least one was seen. `fetch` wraps them (`TypeError: fetch failed` with
 * a `cause`, and an `AggregateError` when several addresses were tried), so the
 * whole chain is inspected: a single post-delivery code makes the outcome
 * ambiguous again.
 */
function failedBeforeDelivery(error: unknown): boolean {
  const codes = new Set<string>();
  collectErrorCodes(error, codes, new Set());
  if (codes.size === 0) return false;
  for (const code of codes) {
    if (PRE_DELIVERY_ERROR_CODES[code] !== true) return false;
  }
  return true;
}

/**
 * Posts a JSON command to a security Worker under the shared internal-service
 * time budget (`CONTROL_PLANE_UPSTREAM_BUDGET_MS`) and parses the response
 * defensively.
 *
 * The budget covers the whole call, body read included: one controller armed
 * for `CONTROL_PLANE_UPSTREAM_BUDGET_MS` is passed to the fetch and stays live
 * while the body is read, so aborting it also errors a body that stalls
 * mid-stream. `fetchWithinBudget` cannot serve here: it clears its timer and
 * drops the caller's abort listener as soon as the response resolves, i.e. when
 * the headers arrive.
 *
 * A Worker that never answers, and a body that is not JSON (a gateway HTML
 * 502/504), leave the Worker's acceptance unknown. Both are the ambiguity class
 * `postSecurityWorkerCommand` classifies transport failures with, so both
 * surface as a retryable `BAD_GATEWAY` `TRPCError` instead of an unbounded
 * request or a raw `SyntaxError` the operation ledger would settle as a
 * definitive pre-acceptance rejection.
 *
 * A connection that was never established is the one failure that is not
 * ambiguous (`failedBeforeDelivery`): nothing was delivered, so it is a
 * definitive rejection — `PRECONDITION_FAILED` with the stable marker the
 * clients map onto "the service is unavailable, try again". The caller's ledger
 * settles the intent `failed`, and the retry is a fresh intent.
 *
 * The URL, the internal-service token, the request body and the response body
 * are never attached to the error.
 */
export async function postSecurityWorkerJson(params: {
  url: string;
  service: SecurityWorkerService;
  body: Record<string, unknown>;
}): Promise<{ response: Response; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONTROL_PLANE_UPSTREAM_BUDGET_MS);
  try {
    const response = await fetch(params.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-api-key': INTERNAL_API_SECRET,
      },
      body: JSON.stringify(params.body),
      signal: controller.signal,
    });
    const body: unknown = await response.json();
    return { response, body };
  } catch (error) {
    if (failedBeforeDelivery(error)) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: SECURITY_SERVICE_UNAVAILABLE_MESSAGE,
      });
    }
    throw new TRPCError({
      code: 'BAD_GATEWAY',
      message: `Could not reach the security ${params.service} service. Try again.`,
    });
  } finally {
    clearTimeout(timer);
  }
}
