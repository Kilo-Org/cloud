import 'server-only';
import { TRPCError } from '@trpc/server';
import { fetchWithinBudget } from '@/lib/bounded-service-fetch';
import { INTERNAL_API_SECRET } from '@kilocode/web-shared/lib/config.server';

/** Security Worker called through this module; used in the client-facing message. */
export type SecurityWorkerService = 'sync' | 'dismissal' | 'analysis' | 'remediation';

/**
 * Posts a JSON command to a security Worker under the shared internal-service
 * time budget (`CONTROL_PLANE_UPSTREAM_BUDGET_MS`) and parses the response
 * defensively.
 *
 * A Worker that never answers aborts inside the budget, and a body that is not
 * JSON (a gateway HTML 502/504) leaves the Worker's acceptance unknown. Both
 * are the ambiguity class `postSecurityWorkerCommand` classifies transport
 * failures with, so both surface as a retryable `BAD_GATEWAY` `TRPCError`
 * instead of an unbounded request or a raw `SyntaxError` the operation ledger
 * would settle as a definitive pre-acceptance rejection.
 *
 * The URL, the internal-service token, the request body and the response body
 * are never attached to the error.
 */
export async function postSecurityWorkerJson(params: {
  url: string;
  service: SecurityWorkerService;
  body: Record<string, unknown>;
}): Promise<{ response: Response; body: unknown }> {
  try {
    const response = await fetchWithinBudget(params.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-api-key': INTERNAL_API_SECRET,
      },
      body: JSON.stringify(params.body),
    });
    const body: unknown = await response.json();
    return { response, body };
  } catch {
    throw new TRPCError({
      code: 'BAD_GATEWAY',
      message: `Could not reach the security ${params.service} service. Try again.`,
    });
  }
}
