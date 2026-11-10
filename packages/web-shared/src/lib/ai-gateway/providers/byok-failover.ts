import type { GetProviderProviderResult } from '@kilocode/web-shared/lib/ai-gateway/providers/get-provider';
import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import {
  sendUpstreamAttempt,
  type SendUpstreamAttemptInput,
  type SendUpstreamAttemptResult,
} from '@kilocode/web-shared/lib/ai-gateway/providers/upstream-attempt';

type ByokFailoverResult = {
  attempt: SendUpstreamAttemptResult;
  /** The route that sent the returned attempt. */
  providerContext: GetProviderProviderResult;
  /** The request as sent for the returned attempt. */
  request: GatewayRequest;
};

function failedStatus(attempt: SendUpstreamAttemptResult): number | null {
  if (attempt.type === 'invalid-openrouter-model' || attempt.response.ok) return null;
  return attempt.response.status;
}

function byokProviderIds(route: GetProviderProviderResult) {
  return route.userByok?.map(byok => byok.providerId) ?? null;
}

async function discardResponse(attempt: SendUpstreamAttemptResult) {
  if (attempt.type === 'invalid-openrouter-model') return;
  await attempt.response.body?.cancel().catch(() => {});
}

/**
 * Sends the request through its route and, while a BYOK key's upstream fails with an
 * unsuccessful status, through the owner's next BYOK key. When every key fails, the last
 * failure is returned: failover never reaches Kilo's route or another payer's connection.
 */
export async function sendUpstreamAttemptWithByokFailover(
  input: SendUpstreamAttemptInput,
  nextByokFailover: () => Promise<GetProviderProviderResult | null>
): Promise<ByokFailoverResult> {
  let providerContext = input.providerContext;
  let request = input.request;
  if (!providerContext.byokFailovers?.length) {
    return { attempt: await sendUpstreamAttempt(input), providerContext, request };
  }

  // Provider transforms mutate the request they send, so each failover sends a copy of the original.
  const original = structuredClone(request);
  let attempt = await sendUpstreamAttempt(input);
  for (;;) {
    const status = failedStatus(attempt);
    if (status === null || input.signal?.aborted) break;
    const next = await nextByokFailover();
    if (!next) break;
    console.warn('[byok-failover] BYOK upstream failed, trying the next BYOK key', {
      status,
      failedProviderIds: byokProviderIds(providerContext),
      nextProviderIds: byokProviderIds(next),
    });
    await discardResponse(attempt);
    providerContext = next;
    request = structuredClone(original);
    attempt = await sendUpstreamAttempt({ ...input, providerContext, request });
  }
  return { attempt, providerContext, request };
}
