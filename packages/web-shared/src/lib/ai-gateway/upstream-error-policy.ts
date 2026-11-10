import {
  captureProxyError,
  temporarilyUnavailableResponse,
} from '@kilocode/web-shared/lib/ai-gateway/llm-proxy-helpers';
import { CLAUDE_BILLING_PROVIDER_ID } from '@kilocode/web-shared/lib/ai-gateway/claude-billing/provider-id';

type UpstreamErrorPolicyParams = {
  response: Response;
  providerId: string;
  isUserByok: boolean;
  user: { id: string };
  request: unknown;
  organizationId: string | undefined;
  model: string;
  gatewayModel?: string;
  byokProviderIds?: ReadonlyArray<string> | null;
};

/**
 * Reports upstream errors and returns a replacement response when the upstream
 * response must not reach the client. Platform-funded 402s are hidden because
 * they concern Kilo's provider account; BYOK 402s concern the user's account.
 * Only platform-funded 402s are captured in Sentry; other upstream HTTP failures
 * are logged, including provider-side 5xx responses.
 */
export async function applyUpstreamErrorPolicy(
  params: UpstreamErrorPolicyParams
): Promise<ReturnType<typeof temporarilyUnavailableResponse> | undefined> {
  const { response, providerId, isUserByok, ...context } = params;
  if (response.status < 400) return undefined;

  const isPlatformPaymentRequired =
    response.status === 402 && !isUserByok && providerId !== CLAUDE_BILLING_PROVIDER_ID;
  await captureProxyError({
    ...context,
    response,
    errorMessage: isPlatformPaymentRequired
      ? `${providerId} returned 402 Payment Required`
      : `${providerId} returned error ${response.status}`,
    trackInSentry: isPlatformPaymentRequired,
  });

  return isPlatformPaymentRequired ? temporarilyUnavailableResponse() : undefined;
}
