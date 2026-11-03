import {
  isVercelUserByokProviderAllowed,
  type UserByokProviderId,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/inference-provider-id';
import { withoutVirtualProvider } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/virtual-models';
import { canRouteToVercel } from '@kilocode/web-shared/lib/ai-gateway/providers/vercel';

/**
 * Whether an enabled key among `modelProviders` serves `modelId` with the
 * user's own credentials. As routing requires, a provider key counts only when
 * the organization's allowed providers for the model admit it, and a Vercel AI
 * Gateway key only when Vercel can honor them; otherwise the request falls
 * through to a route Kilo pays for.
 */
export async function hasEnabledUserByokForModel({
  modelId,
  modelProviders,
  enabledProviderIds,
  allowedProviders,
}: {
  modelId: string;
  modelProviders: readonly UserByokProviderId[];
  enabledProviderIds: ReadonlySet<UserByokProviderId>;
  allowedProviders: ReadonlySet<string> | undefined;
}): Promise<boolean> {
  for (const providerId of modelProviders) {
    if (!enabledProviderIds.has(providerId)) continue;
    if (!isVercelUserByokProviderAllowed(providerId, allowedProviders)) continue;
    if (providerId !== 'vercel-ai-gateway' || !allowedProviders) return true;
    const only = withoutVirtualProvider([...allowedProviders]);
    if (await canRouteToVercel(modelId, async () => ({ only }))) return true;
  }
  return false;
}
