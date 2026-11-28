import { getOrganizationProviderPrivacy } from '@kilocode/web-shared/lib/ai-gateway/llm-proxy-helpers';
import {
  composeProviderPreferences,
  type getEffectiveProviderPrivacy,
} from '@kilocode/web-shared/lib/ai-gateway/provider-privacy';
import type { OpenRouterProviderConfig } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import { withoutVirtualProvider } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/virtual-models';
import type { OrganizationSettings } from '@kilocode/web-shared/lib/organizations/organization-types';
import {
  getEffectiveModelDecision,
  type EffectiveModelDecision,
  type EffectiveOrganizationModelPolicy,
} from '@kilocode/web-shared/lib/organizations/group-policies/model-access/model-access.server';

export type ModelProviderAccess = {
  /** The member's decision for the model, or undefined outside an organization policy. */
  groupDecision: EffectiveModelDecision | undefined;
  /** The providers the policy lets serve the model, or undefined when it restricts none. */
  allowedProviders: ReadonlySet<string> | undefined;
  /** The provider routing settings the request runs under, when the organization changes them. */
  effectiveProviderConfig: OpenRouterProviderConfig | undefined;
  /** The organization's providers and the request's own leave no provider to route to. */
  providerPreferencesExhausted: boolean;
};

/**
 * The provider restrictions a request for `model` routes under: the member's policy decision and
 * the organization's privacy and provider routes composed over the request's own provider object.
 * Provider selection and the inference region auto-routing check both derive them here.
 */
export async function resolveModelProviderAccess(params: {
  model: string;
  groupPolicy: EffectiveOrganizationModelPolicy | null;
  settings: OrganizationSettings | undefined;
  requestProvider: OpenRouterProviderConfig | undefined;
  effectivePrivacy: ReturnType<typeof getEffectiveProviderPrivacy>;
}): Promise<ModelProviderAccess> {
  const { model, groupPolicy, settings, requestProvider, effectivePrivacy } = params;
  const groupDecision = groupPolicy
    ? await getEffectiveModelDecision(groupPolicy, model)
    : undefined;
  // An `organization_provider` denial means no allowed provider serves the model.
  const allowedProviders = groupDecision
    ? groupDecision.allowed
      ? groupDecision.eligibleProviderRoutes
      : new Set<string>()
    : undefined;
  const organizationOnly = groupDecision?.eligibleProviderRoutes
    ? withoutVirtualProvider([...groupDecision.eligibleProviderRoutes])
    : undefined;
  if (!getOrganizationProviderPrivacy(settings) && !organizationOnly) {
    return {
      groupDecision,
      allowedProviders,
      effectiveProviderConfig: undefined,
      providerPreferencesExhausted: false,
    };
  }
  const composed = composeProviderPreferences({
    requestProvider,
    organizationOnly,
    effectivePrivacy,
  });
  return composed.kind === 'none'
    ? {
        groupDecision,
        allowedProviders,
        effectiveProviderConfig: undefined,
        providerPreferencesExhausted: true,
      }
    : {
        groupDecision,
        allowedProviders,
        effectiveProviderConfig: composed.provider,
        providerPreferencesExhausted: false,
      };
}
