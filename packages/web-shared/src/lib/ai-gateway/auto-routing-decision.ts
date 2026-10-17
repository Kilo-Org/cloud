import {
  AutoRoutingDecisionResponseSchema,
  CustomRouterErrorResponseSchema,
  detectRequiredInputModalities,
  estimateRoutingTokens,
  type AutoRoutingDecision,
  type AutoRoutingDecisionResponse,
  type AutoRouter,
  type CustomRouterErrorCode,
  type CustomRouterErrorResponse,
  type CustomRouterReference,
  normalizeClassifierInput,
} from '@kilocode/auto-routing-contracts';
import type { ClassifierApiKind, MirrorPayload } from '@kilocode/auto-routing-contracts';
import {
  AUTO_ROUTING_WORKER_URL,
  INTERNAL_API_SECRET,
} from '@kilocode/web-shared/lib/config.server';
import { warnExceptInTest } from '@kilocode/web-shared/lib/utils.server';

export const EFFICIENT_DECISION_TIMEOUT_MS = 5_000;
export const FRONTIER_ROUTING_FLAG = 'kilo-auto-frontier-routing';

export type EfficientDecisionParams = {
  router?: AutoRouter;
  customRouter?: CustomRouterReference;
  apiKind: ClassifierApiKind;
  body: unknown;
  requestedModel: string;
  providerHints: MirrorPayload['input']['providerHints'];
  bodyBytes: number;
  userId: string;
  organizationId: string | null;
  sessionId: string | null;
  machineId: string | null;
  clientRequestId: string | null;
  mode: string | null;
  userAgent: string | null;
  deniedModelIds?: ReadonlyArray<string>;
};

type FetchEfficientDecisionOptions = {
  workerUrl?: string;
  authToken?: string;
  timeoutMs?: number;
  onError?: (message: string, data: { error: string }) => void;
};

function buildDecidePayload(params: EfficientDecisionParams): MirrorPayload | null {
  const normalizedInput = normalizeClassifierInput(params.apiKind, params.body, {
    requestedModel: params.requestedModel,
    providerHints: params.providerHints,
  });
  if (!normalizedInput) return null;

  // Compute capability-aware routing hints from the original body (the
  // caller mutates it after this thunk runs, so the full body is only
  // available here). Omit each field when it carries no information, and
  // omit `constraints` entirely when both would be absent, so today's
  // payload shape is preserved byte-for-byte for text-only, sub-token
  // requests.
  const requiredInputModalities = detectRequiredInputModalities(params.body);
  const promptTokensEstimate = estimateRoutingTokens(params.body);
  const constraints: MirrorPayload['constraints'] =
    requiredInputModalities.length > 0 || promptTokensEstimate > 0
      ? {
          ...(requiredInputModalities.length > 0 ? { requiredInputModalities } : {}),
          ...(promptTokensEstimate > 0 ? { promptTokensEstimate } : {}),
        }
      : undefined;

  return {
    input: normalizedInput,
    ...(params.router ? { router: params.router } : {}),
    ...(params.customRouter ? { customRouter: params.customRouter } : {}),
    ...(params.deniedModelIds?.length
      ? { routingPolicy: { deniedModelIds: [...params.deniedModelIds] } }
      : {}),
    ...(constraints ? { constraints } : {}),
    userId: params.userId,
    organizationId: params.organizationId,
    sessionId: params.sessionId,
    machineId: params.machineId,
    clientRequestId: params.clientRequestId,
    mode: params.mode,
    userAgent: params.userAgent,
    bodyBytes: params.bodyBytes,
  };
}

type DecideOutcome =
  | { kind: 'ok'; response: AutoRoutingDecisionResponse }
  | { kind: 'rejected'; error: CustomRouterErrorResponse['error'] }
  | { kind: 'failed' };

async function postDecision(
  payload: MirrorPayload,
  workerUrl: string,
  authToken: string,
  options: FetchEfficientDecisionOptions
): Promise<DecideOutcome> {
  const onError = options.onError ?? warnExceptInTest;
  const startedAt = performance.now();
  let status: number | null = null;
  let outcome: 'ok' | 'timeout' | 'error' | 'http_error' | 'invalid_response' = 'error';
  let signal: AbortSignal | undefined;
  try {
    signal = AbortSignal.timeout(options.timeoutMs ?? EFFICIENT_DECISION_TIMEOUT_MS);
    const response = await fetch(`${workerUrl}/decide`, {
      method: 'POST',
      headers: new Headers({
        authorization: `Bearer ${authToken}`,
        'content-type': 'application/json',
      }),
      body: JSON.stringify(payload),
      signal,
    });
    status = response.status;
    if (!response.ok) {
      outcome = 'http_error';
      const rejection = CustomRouterErrorResponseSchema.safeParse(
        await response.json().catch(() => null)
      );
      if (!rejection.success || !isCallerRejection(rejection.data.error.code)) {
        onError('Efficient auto decision request failed', { error: `status ${response.status}` });
      }
      return rejection.success
        ? { kind: 'rejected', error: rejection.data.error }
        : { kind: 'failed' };
    }
    const parsed = AutoRoutingDecisionResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      outcome = 'invalid_response';
      onError('Efficient auto decision response invalid', { error: 'invalid_response' });
      return { kind: 'failed' };
    }
    outcome = 'ok';
    return { kind: 'ok', response: parsed.data };
  } catch (error) {
    outcome = signal?.aborted ? 'timeout' : 'error';
    onError('Efficient auto decision request failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { kind: 'failed' };
  } finally {
    const durationMs = performance.now() - startedAt;
    const sampled = outcome === 'ok';
    if (!sampled || Math.random() < 0.01) {
      console.log(
        JSON.stringify({
          event: 'auto_routing_decide_client',
          durationMs,
          outcome,
          status,
          sampled,
          customRouter: payload.customRouter !== undefined,
        })
      );
    }
  }
}

// Worker-owned usage survives a lost response. Positive response costs belong
// to legacy workers and must still be billed by the gateway during rollout.
export async function fetchEfficientAutoDecision(
  params: EfficientDecisionParams,
  options: FetchEfficientDecisionOptions = {}
): Promise<{ decision: AutoRoutingDecision | null; costUsd: number } | null> {
  const workerUrl = options.workerUrl ?? AUTO_ROUTING_WORKER_URL;
  const authToken = options.authToken ?? INTERNAL_API_SECRET;
  if (!workerUrl || !authToken) return null;

  const payload = buildDecidePayload(params);
  if (!payload) return null;

  const outcome = await postDecision(payload, workerUrl, authToken, options);
  return outcome.kind === 'ok'
    ? { decision: outcome.response.decision, costUsd: outcome.response.cost }
    : null;
}

export type CustomRouterDecisionOutcome =
  | { kind: 'ok'; decision: AutoRoutingDecision | null; costUsd: number }
  | { kind: 'rejected'; code: CustomRouterErrorCode; message: string }
  | { kind: 'unavailable' };

// Only rejections about the caller's router reach the client. Any other worker error (an internal
// secret mismatch, a quota, an internal fault) is the gateway's problem, not the caller's.
const CALLER_REJECTIONS = ['router_not_found', 'custom_router_unavailable'] as const;

function isCallerRejection(code: CustomRouterErrorCode): boolean {
  return (CALLER_REJECTIONS as readonly CustomRouterErrorCode[]).includes(code);
}

// A custom router never falls back outside its pool (ADR 0005 invariant 2), so a worker that
// cannot answer is reported as such instead of turning into a static fallback model.
export async function fetchCustomRouterDecision(
  params: EfficientDecisionParams & { customRouter: CustomRouterReference },
  options: FetchEfficientDecisionOptions = {}
): Promise<CustomRouterDecisionOutcome> {
  const workerUrl = options.workerUrl ?? AUTO_ROUTING_WORKER_URL;
  const authToken = options.authToken ?? INTERNAL_API_SECRET;
  if (!workerUrl || !authToken) return { kind: 'unavailable' };

  const payload = buildDecidePayload(params);
  if (!payload) {
    return { kind: 'rejected', code: 'invalid_request', message: 'Messages cannot be classified' };
  }

  const outcome = await postDecision(payload, workerUrl, authToken, options);
  if (outcome.kind === 'ok') {
    return { kind: 'ok', decision: outcome.response.decision, costUsd: outcome.response.cost };
  }
  if (outcome.kind === 'rejected' && isCallerRejection(outcome.error.code)) {
    return { kind: 'rejected', code: outcome.error.code, message: outcome.error.message };
  }
  return { kind: 'unavailable' };
}
