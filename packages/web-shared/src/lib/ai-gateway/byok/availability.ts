import type { UserByokProviderId } from '@/lib/ai-gateway/providers/openrouter/inference-provider-id';
import { withoutVirtualProvider } from '@/lib/ai-gateway/providers/openrouter/virtual-models';
import { canRouteToVercel } from '@/lib/ai-gateway/providers/vercel';

/**
 * Whether an enabled key among `modelProviders` serves `modelId` with the
 * user's own credentials. A Vercel AI Gateway key counts only when Vercel can
 * honor the organization's allowed providers for the model, as routing requires;
 * otherwise the request falls through to a route Kilo pays for.
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
    if (providerId !== 'vercel-ai-gateway' || !allowedProviders) return true;
    const only = withoutVirtualProvider([...allowedProviders]);
    if (await canRouteToVercel(modelId, async () => ({ only }))) return true;
  }
  return false;
}
