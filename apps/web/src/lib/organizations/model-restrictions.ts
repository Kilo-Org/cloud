import type { Organization } from '@kilocode/db/schema';

// Teams plans store deny lists but do not enforce them.
export function getEffectiveModelRestrictions(organization: Organization): {
  modelDenyList: string[];
  providerDenyList: string[];
} {
  if (organization.plan !== 'enterprise') {
    return { modelDenyList: [], providerDenyList: [] };
  }
  return {
    modelDenyList: organization.settings?.model_deny_list ?? [],
    providerDenyList: organization.settings?.provider_deny_list ?? [],
  };
}
