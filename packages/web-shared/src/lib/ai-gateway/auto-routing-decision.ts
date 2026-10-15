import {
  AutoRoutingDecisionResponseSchema,
  detectRequiredInputModalities,
  estimateRoutingTokens,
  type AutoRoutingDecision,
  type AutoRouter,
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

// Worker-owned usage survives a lost response. Positive response costs belong
// to legacy workers and must still be billed by the gateway during rollout.
export async function fetchEfficientAutoDecision(
  params: EfficientDecisionParams,
  options: FetchEfficientDecisionOptions = {}
): Promise<{ decision: AutoRoutingDecision | null; costUsd: number } | null> {
  const workerUrl = options.workerUrl ?? AUTO_ROUTING_WORKER_URL;
  const authToken = options.authToken ?? INTERNAL_API_SECRET;
  const onError = options.onError ?? warnExceptInTest;
  if (!workerUrl || !authToken) return null;

  const payload = buildDecidePayload(params);
  if (!payload) return null;

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
      onError('Efficient auto decision request failed', { error: `status ${response.status}` });
      return null;
    }
    const parsed = AutoRoutingDecisionResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      outcome = 'invalid_response';
      onError('Efficient auto decision response invalid', { error: 'invalid_response' });
      return null;
    }
    outcome = 'ok';
    return { decision: parsed.data.decision, costUsd: parsed.data.cost };
  } catch (error) {
    outcome = signal?.aborted ? 'timeout' : 'error';
    onError('Efficient auto decision request failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
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
        })
      );
    }
  }
}
