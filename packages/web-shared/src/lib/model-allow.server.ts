import 'server-only';
import {
  KILO_AUTO_MODEL_PREFIX,
  normalizeModelId,
} from '@kilocode/web-shared/lib/ai-gateway/model-utils';
import {
  findCustomLlm,
  getPublicCustomLlmInferenceProviders,
} from '@kilocode/web-shared/lib/ai-gateway/custom-llm/custom-llm-catalog';
import { hasCustomLlmAccess } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/access';
import { getDirectByokModel } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok';
import { getProviderSlugsForModel } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/models-by-provider-index.server';
import {
  normalizeInferenceProviderId,
  normalizeInferenceProviderIds,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/inference-provider-id';
import {
  VIRTUAL_PROVIDER,
  withoutVirtualProvider,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/virtual-models';

export type ProviderAwareAllowPredicate = (modelId: string) => Promise<boolean>;

/** The organization, and the member's groups in it, whose custom LLM grants apply. */
export type CustomLlmGrantee = { organizationId: string; groupIds: readonly string[] };

export type ModelRestrictions = {
  requireModelInCurrentSnapshot: boolean;
  providerAllowList?: string[];
  modelDenyList: string[];
  /** Without a grantee no custom LLM is exempt from these restrictions. */
  customLlmGrantee?: CustomLlmGrantee;
};

/**
 * Resolves the providers that can serve a model. Receives the requested model id
 * as-is (including variant suffixes such as `:free`) so implementations can
 * distinguish variants that are served by different providers.
 */
export type ProviderLookup = (modelId: string) => Promise<ReadonlySet<string>>;

/**
 * Whether `modelId` bypasses organization model and provider policy. Three
 * classes do:
 *
 * - A custom LLM is exempt only for a grantee it is granted to: a Kilo admin
 *   allowlisted that organization or group, which overrides organization policy.
 * - Every `kilo-auto/` id is exempt. A router picks the model and provider per
 *   request, so the policy applies to what it resolves to, not to the router id.
 * - Every direct-BYOK model is exempt. The owner's own credential pays for the
 *   request; a bespoke id bypasses the route access check, and a catalog-mode key
 *   is decided per key provider by `isModelAllowedForProviderKey`.
 */
export async function isModelRestrictionExempt(
  modelId: string,
  customLlmGrantee: CustomLlmGrantee | undefined
): Promise<boolean> {
  const requestedModelId = modelId.trim().toLowerCase();
  if (requestedModelId.startsWith(KILO_AUTO_MODEL_PREFIX)) {
    return true;
  }
  const customLlm = await findCustomLlm(requestedModelId);
  if (customLlm) {
    return (
      customLlmGrantee !== undefined &&
      hasCustomLlmAccess(
        customLlm.definition,
        customLlmGrantee.organizationId,
        customLlmGrantee.groupIds
      )
    );
  }
  const directByokModel = await getDirectByokModel(requestedModelId);
  return directByokModel !== null;
}

/**
 * Providers a model is pinned to regardless of the snapshot: those a public
 * custom LLM declares. Undefined when the snapshot decides.
 */
export async function getModelInferenceProviders(
  modelId: string
): Promise<ReadonlySet<string> | undefined> {
  return (await getPublicCustomLlmInferenceProviders(modelId)) ?? undefined;
}

export function hasActiveModelRestrictions(restrictions: ModelRestrictions): boolean {
  return restrictions.providerAllowList !== undefined || restrictions.modelDenyList.length > 0;
}

/**
 * Routers listed under the snapshot-only virtual provider pick a real provider
 * per request. Allowing `virtual` lets them route to every real provider that
 * the same allow list permits; without one, they have nowhere to route.
 *
 * Both model-decision engines share this rule so the same restrictions always
 * admit the same routes. Both arguments hold canonical provider slugs by
 * construction, so the membership test is an exact match: every allow set goes
 * through `normalizeInferenceProviderIds`, and every provider set arrives from
 * `buildModelIdToProviderSlugsIndex`, which canonicalizes each snapshot slug.
 */
export function getEligibleProviderRoutes(
  modelProviders: ReadonlySet<string>,
  allowedProviders: ReadonlySet<string>
): Set<string> {
  if (modelProviders.has(VIRTUAL_PROVIDER.slug) && allowedProviders.has(VIRTUAL_PROVIDER.slug)) {
    const realProviders = withoutVirtualProvider([...allowedProviders]);
    return new Set(realProviders.length > 0 ? [VIRTUAL_PROVIDER.slug, ...realProviders] : []);
  }
  return new Set([...modelProviders].filter(provider => allowedProviders.has(provider)));
}

export function createAllowPredicateFromProviderAllowList(
  modelDenyList: string[] | undefined,
  providerAllowList: string[] | undefined,
  providerLookup: ProviderLookup = getProviderSlugsForModel,
  requireModelInCurrentSnapshot = false,
  customLlmGrantee?: CustomLlmGrantee
): ProviderAwareAllowPredicate {
  const modelDenySet = new Set(modelDenyList?.map(normalizeModelId));
  const providerAllowSet = providerAllowList
    ? new Set(normalizeInferenceProviderIds(providerAllowList))
    : undefined;
  return async (modelId: string): Promise<boolean> => {
    const normalizedModelId = normalizeModelId(modelId);
    if (!requireModelInCurrentSnapshot && !providerAllowSet && modelDenySet.size === 0) return true;
    if (await isModelRestrictionExempt(modelId, customLlmGrantee)) return true;
    if (modelDenySet.has(normalizedModelId)) {
      return false;
    }
    // Providers resolve only after the exemption and the deny list decide, so
    // neither pays for a lookup. The organization-ceiling branch of
    // `getEffectiveModelDecision` performs the same lookup (pinned providers
    // first, then the snapshot) and calls the same rule, so both engines resolve
    // providers here rather than one eagerly and one lazily.
    const providerSlugs =
      (await getModelInferenceProviders(modelId)) ?? (await providerLookup(modelId));
    if (providerSlugs.size === 0) return false;
    if (!providerAllowSet) return true;
    // Both sides are canonical: the allow set above already went through
    // `normalizeInferenceProviderIds`, and each provider set arrives either from
    // the provider index (canonicalized snapshot slugs) or from a public custom LLM
    // definition. The shared route rule therefore compares exact strings.
    return getEligibleProviderRoutes(providerSlugs, providerAllowSet).size > 0;
  };
}

export function createAllowPredicateFromRestrictions(
  restrictions: ModelRestrictions,
  providerLookup: ProviderLookup = getProviderSlugsForModel
): ProviderAwareAllowPredicate {
  return createAllowPredicateFromProviderAllowList(
    restrictions.modelDenyList,
    restrictions.providerAllowList,
    providerLookup,
    restrictions.requireModelInCurrentSnapshot,
    restrictions.customLlmGrantee
  );
}
