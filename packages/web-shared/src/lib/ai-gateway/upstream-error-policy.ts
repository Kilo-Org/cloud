import {
  captureProxyError,
  temporarilyUnavailableResponse,
} from '@kilocode/web-shared/lib/ai-gateway/llm-proxy-helpers';

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
 */
export async function applyUpstreamErrorPolicy(
  params: UpstreamErrorPolicyParams
): Promise<ReturnType<typeof temporarilyUnavailableResponse> | undefined> {
  const { response, providerId, isUserByok, ...context } = params;
  if (response.status < 400) return undefined;

  const isPlatformPaymentRequired = response.status === 402 && !isUserByok;
  await captureProxyError({
    ...context,
    response,
    errorMessage: isPlatformPaymentRequired
      ? `${providerId} returned 402 Payment Required`
      : `${providerId} returned error ${response.status}`,
    trackInSentry: isPlatformPaymentRequired || response.status >= 500,
  });

  return isPlatformPaymentRequired ? temporarilyUnavailableResponse() : undefined;
}
