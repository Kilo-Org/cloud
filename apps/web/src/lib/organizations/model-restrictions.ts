import type { Organization } from '@kilocode/db/schema';
import type { ModelRestrictions } from '@/lib/model-allow.server';

// Teams plans store deny lists but do not enforce them.
export function getEffectiveModelRestrictions(organization: Organization): ModelRestrictions {
  if (organization.plan !== 'enterprise') {
    return { modelDenyList: [], providerDenyList: [] };
  }
  return {
    providerAllowList:
      organization.settings?.provider_policy_mode === 'allow'
        ? organization.settings.provider_allow_list
        : undefined,
    modelDenyList: organization.settings?.model_deny_list ?? [],
    providerDenyList: organization.settings?.provider_deny_list ?? [],
  };
}
