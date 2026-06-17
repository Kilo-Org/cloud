import {
  AutoRoutingDecisionResponseSchema,
  type AutoRoutingDecision,
} from '@kilocode/auto-routing-contracts';
import { AUTO_ROUTING_WORKER_URL, INTERNAL_API_SECRET } from '@/lib/config.server';
import { warnExceptInTest } from '@/lib/utils.server';
import { buildDecidePayload, type DecideBaseParams } from './auto-routing-mirror';

export const EFFICIENT_DECISION_TIMEOUT_MS = 2_000;

// EfficientDecisionParams is an alias for the shared base params type.
export type EfficientDecisionParams = DecideBaseParams;

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
): Promise<{ decision: AutoRoutingDecision | null; costUsd: number } | null> {
  const workerUrl = options.workerUrl ?? AUTO_ROUTING_WORKER_URL;
  const authToken = options.authToken ?? INTERNAL_API_SECRET;
  const onError = options.onError ?? warnExceptInTest;
  if (!workerUrl || !authToken) return null;

  const payload = buildDecidePayload(params);
  if (!payload) return null;

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
    return { decision: parsed.data.decision, costUsd: parsed.data.cost };
  } catch (error) {
    onError('Efficient auto decision request failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
