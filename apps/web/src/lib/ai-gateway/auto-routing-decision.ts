import {
  AutoRoutingDecisionResponseSchema,
  normalizeClassifierInput,
  type AutoRoutingDecision,
  type ClassifierApiKind,
  type MirrorPayload,
} from '@kilocode/auto-routing-contracts';
import { AUTO_ROUTING_WORKER_URL, INTERNAL_API_SECRET } from '@/lib/config.server';
import { warnExceptInTest } from '@/lib/utils.server';

export const EFFICIENT_DECISION_TIMEOUT_MS = 2_000;

export type EfficientDecisionParams = {
  apiKind: ClassifierApiKind;
  body: unknown;
  requestedModel: string;
  providerHints: MirrorPayload['input']['providerHints'];
  bodyBytes: number;
  userId: string;
  sessionId: string | null;
  machineId: string | null;
  clientRequestId: string | null;
  mode: string | null;
  userAgent: string | null;
};

type FetchEfficientDecisionOptions = {
  workerUrl?: string;
  authToken?: string;
  timeoutMs?: number;
  onError?: (message: string, data: { error: string }) => void;
};

// Blocking counterpart of the fire-and-forget mirror: kilo-auto/efficient
// waits for the worker's routing decision (cache hits ~20ms, classifier
// misses ~1.2s) and falls back to the static default on timeout or error.
export async function fetchEfficientAutoDecision(
  params: EfficientDecisionParams,
  options: FetchEfficientDecisionOptions = {}
): Promise<AutoRoutingDecision | null> {
  const workerUrl = options.workerUrl ?? AUTO_ROUTING_WORKER_URL;
  const authToken = options.authToken ?? INTERNAL_API_SECRET;
  const onError = options.onError ?? warnExceptInTest;
  if (!workerUrl || !authToken) return null;

  const normalizedInput = normalizeClassifierInput(params.apiKind, params.body, {
    requestedModel: params.requestedModel,
    providerHints: params.providerHints,
  });
  if (!normalizedInput) return null;

  const payload: MirrorPayload = {
    input: normalizedInput,
    userId: params.userId,
    sessionId: params.sessionId,
    machineId: params.machineId,
    clientRequestId: params.clientRequestId,
    mode: params.mode,
    userAgent: params.userAgent,
    bodyBytes: params.bodyBytes,
  };

  try {
    const response = await fetch(`${workerUrl}/decide`, {
      method: 'POST',
      headers: new Headers({
        authorization: `Bearer ${authToken}`,
        'content-type': 'application/json',
      }),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(options.timeoutMs ?? EFFICIENT_DECISION_TIMEOUT_MS),
    });
    if (!response.ok) {
      onError('Efficient auto decision request failed', { error: `status ${response.status}` });
      return null;
    }
    const parsed = AutoRoutingDecisionResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      onError('Efficient auto decision response invalid', { error: 'invalid_response' });
      return null;
    }
    return parsed.data.decision;
  } catch (error) {
    onError('Efficient auto decision request failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
