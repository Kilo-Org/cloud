import 'server-only';
import { TRPCError } from '@trpc/server';
import { CONTROL_PLANE_UPSTREAM_BUDGET_MS } from '@/lib/bounded-service-fetch';
import { INTERNAL_API_SECRET } from '@kilocode/web-shared/lib/config.server';

/** Security Worker called through this module; used in the client-facing message. */
export type SecurityWorkerService = 'sync' | 'dismissal' | 'analysis' | 'remediation';

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
  } catch {
    throw new TRPCError({
      code: 'BAD_GATEWAY',
      message: `Could not reach the security ${params.service} service. Try again.`,
    });
  } finally {
    clearTimeout(timer);
  }
}
