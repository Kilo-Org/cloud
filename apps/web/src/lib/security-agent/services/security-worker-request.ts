import 'server-only';
import { TRPCError } from '@trpc/server';
import type { ServiceTokenRequest } from '@kilocode/service-token-client';
import { SECURITY_SERVICE_NOT_CONFIGURED_MESSAGE } from '@kilocode/app-shared/security-agent';
import {
  SECURITY_AUTO_ANALYSIS_SENDER_AUTH,
  SECURITY_AUTO_ANALYSIS_WORKER_URL,
  SECURITY_SYNC_SENDER_AUTH,
  SECURITY_SYNC_WORKER_URL,
} from '@kilocode/web-shared/lib/config.server';
import { readInternalApiSecret } from '@kilocode/web-shared/lib/internal-api-secret';
import {
  resolveServiceSenderAuth,
  serviceSenderHeaders,
  type ServiceSenderAuth,
} from '@kilocode/web-shared/lib/service-sender-auth';
import {
  CONTROL_PLANE_UPSTREAM_BUDGET_MS,
  fetchWithinBudget,
  readJsonWithinBudget,
  withinBudget,
} from '@/lib/bounded-service-fetch';

/** Security Worker called through this module; used in the client-facing message. */
export type SecurityWorkerService = 'sync' | 'dismissal' | 'analysis' | 'remediation';

/** One security Worker's credential switch (`service-sender-auth.ts`), resolved once. */
export type SecurityWorkerSender = { sender: ServiceSenderAuth; variable: string; label: string };

/**
 * `SECURITY_SYNC_SENDER_AUTH`: `legacy` (also when unset) sends the internal API secret in
 * `x-internal-api-key`, as before; explicit `sts` sends only a `security-sync` STS token scoped to
 * the route (`manual-sync.enqueue`, `dismiss-finding.enqueue`).
 */
export const SECURITY_SYNC_WORKER_SENDER: SecurityWorkerSender = {
  sender: resolveServiceSenderAuth({
    auth: SECURITY_SYNC_SENDER_AUTH,
    url: SECURITY_SYNC_WORKER_URL,
    runtime: process.env,
  }),
  variable: 'SECURITY_SYNC_SENDER_AUTH',
  label: 'security sync worker client',
};

/**
 * `SECURITY_AUTO_ANALYSIS_SENDER_AUTH`: `legacy` (also when unset) sends the internal API secret in
 * `x-internal-api-key`, as before; explicit `sts` sends only a
 * `security-auto-analysis:internal.call` STS token.
 */
export const SECURITY_AUTO_ANALYSIS_WORKER_SENDER: SecurityWorkerSender = {
  sender: resolveServiceSenderAuth({
    auth: SECURITY_AUTO_ANALYSIS_SENDER_AUTH,
    url: SECURITY_AUTO_ANALYSIS_WORKER_URL,
    runtime: process.env,
  }),
  variable: 'SECURITY_AUTO_ANALYSIS_SENDER_AUTH',
  label: 'security auto-analysis worker client',
};

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
 * Shared classification of a non-OK Worker response for the operation ledger:
 * `true` is a definitive pre-acceptance rejection (nothing was enqueued, the
 * caller may record `failed` and re-submit as a fresh intent); `false` is
 * ambiguous transport (the Worker may still have accepted, so the caller
 * surfaces a retryable error and lets a same-key retry reconcile).
 *
 * Every security Worker route shares the rule: any 4xx is definitive. A 5xx is
 * ambiguous — including a gateway 503 that may have arrived after the Worker
 * accepted — unless the caller names the route's known disabled-routing body,
 * which the Worker returns before it creates the command row. Only that 503 is
 * definitive, and only when the parsed body matches. `requireSuccessFalse`
 * keeps the sync/dismissal bodies as they were accepted: there the
 * disabled-routing body must also carry `success: false`. `body` is read only
 * for a named disabled-routing 503; a route without one (the remediation
 * routes) stays all-5xx-ambiguous whatever the body says.
 */
export function isDefinitiveSecurityWorkerRejection(params: {
  status: number;
  body: unknown;
  /** The route's known pre-enqueue disabled-routing error body, if it has one. */
  disabledRoutingError?: string;
  /** Require `success === false` beside the disabled-routing error. */
  requireSuccessFalse?: boolean;
}): boolean {
  if (params.status < 500) return true;
  if (params.disabledRoutingError === undefined) return false;
  if (params.status !== 503) return false;
  if (params.body === null || typeof params.body !== 'object') return false;
  const { error, success } = params.body as { error?: unknown; success?: unknown };
  if (error !== params.disabledRoutingError) return false;
  if (params.requireSuccessFalse === true && success !== false) return false;
  return true;
}

/**
 * Posts a JSON command to a security Worker under the shared internal-service
 * time budget (`CONTROL_PLANE_UPSTREAM_BUDGET_MS`) and parses the response
 * defensively.
 *
 * The budget covers the whole call, body read included: `fetchWithinBudget`
 * bounds the request up to the response headers, and `readJsonWithinBudget`
 * bounds the body read by what is left of the same
 * `CONTROL_PLANE_UPSTREAM_BUDGET_MS`, so an upstream that stalls mid-body is
 * abandoned inside the same total budget instead of holding the request open.
 *
 * A Worker that never answers, a stalled body, and a body that is not JSON (a
 * gateway HTML 502/504) leave the Worker's acceptance unknown. All are the
 * ambiguity class `postSecurityWorkerCommand` classifies transport failures
 * with, so all surface as a retryable `BAD_GATEWAY` `TRPCError` instead of an
 * unbounded request or a raw `SyntaxError` the operation ledger would settle
 * as a definitive pre-acceptance rejection.
 *
 * A connection that was never established is the one failure that is not
 * ambiguous (`failedBeforeDelivery`): nothing was delivered, so it is a
 * definitive rejection — `PRECONDITION_FAILED` with the stable marker the
 * clients map onto "the service is unavailable, try again". The caller's ledger
 * settles the intent `failed`, and the retry is a fresh intent.
 *
 * The credential comes first, inside the same budget: the Worker's switch picks the internal API
 * secret or an STS token for `scope`. Legacy without the secret is the not-configured
 * precondition, as before; a refused switch, no token, or a mint past the budget throws before
 * anything is sent. An STS token is for the Worker's origin only, so a redirect is an error.
 *
 * The URL, the internal-service token, the request body and the response body
 * are never attached to the error.
 */
export async function postSecurityWorkerJson(params: {
  url: string;
  service: SecurityWorkerService;
  worker: SecurityWorkerSender;
  /** The route's STS scope; read only under `sts`. */
  scope: ServiceTokenRequest;
  body: Record<string, unknown>;
}): Promise<{ response: Response; body: unknown }> {
  const startedAt = Date.now();
  const { sender, variable, label } = params.worker;
  const credential = await withinBudget(
    serviceSenderHeaders({
      sender,
      variable,
      label,
      request: params.scope,
      legacyHeaders: async () => {
        const internalApiSecret = await readInternalApiSecret();
        if (!internalApiSecret) {
          // Mirrored by the mobile security mutation classifier: a stable
          // non-retryable code (PRECONDITION_FAILED), not the generic 500 the
          // classifier treats as retryable transport. The sentence is the shared
          // SECURITY_SERVICE_NOT_CONFIGURED_MESSAGE, which the mobile ledger maps
          // by exact match (stable-error-messages).
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: SECURITY_SERVICE_NOT_CONFIGURED_MESSAGE,
          });
        }
        return { 'x-internal-api-key': internalApiSecret };
      },
    }),
    CONTROL_PLANE_UPSTREAM_BUDGET_MS
  );
  const init: RequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...credential },
    body: JSON.stringify(params.body),
  };
  if (sender.kind === 'sts') init.redirect = 'error';
  try {
    // The shared internal-service budget, one implementation for every caller,
    // less what the credential read spent.
    const response = await fetchWithinBudget(params.url, init, {
      budgetMs: CONTROL_PLANE_UPSTREAM_BUDGET_MS - (Date.now() - startedAt),
    });
    const body: unknown = await readJsonWithinBudget(
      response,
      CONTROL_PLANE_UPSTREAM_BUDGET_MS - (Date.now() - startedAt),
      CONTROL_PLANE_UPSTREAM_BUDGET_MS
    );
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
  }
}
