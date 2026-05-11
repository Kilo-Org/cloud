import type { Organization } from '@kilocode/db/schema';
import type { ModelRestrictions } from '@/lib/model-allow.server';

// Teams plans store deny lists but do not enforce them.
export function getEffectiveModelRestrictions(organization: Organization): ModelRestrictions {
  if (organization.plan !== 'enterprise') {
    return { modelDenyList: [] };
  }
  return {
    providerAllowList: organization.settings?.provider_allow_list,
    modelDenyList: organization.settings?.model_deny_list ?? [],
  };
}
