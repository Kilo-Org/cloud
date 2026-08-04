import type { OrganizationGroupPolicyListItemProps } from '@/components/organizations/groups/policies/types';

export function summarizeModelAccessPolicy(
  policy: OrganizationGroupPolicyListItemProps<'model_access'>['policy']
) {
  if (policy.data.mode === 'all') return 'All organization-approved models';
  if (policy.data.mode === 'none') return 'No model access';
  const models = policy.data.model_allow_list.length;
  const providers = policy.data.provider_allow_list.length;
  if (models && providers) return `${models} models, ${providers} providers`;
  if (models) return `${models} ${models === 1 ? 'model' : 'models'}`;
  return `${providers} ${providers === 1 ? 'provider' : 'providers'}`;
}

export function ModelAccessPolicyListItem({
  policy,
}: OrganizationGroupPolicyListItemProps<'model_access'>) {
  return (
    <span className="min-w-0">
      <span className="type-body block font-medium">Model access</span>
      <span className="type-label text-muted-foreground block">
        {summarizeModelAccessPolicy(policy)}
      </span>
    </span>
  );
}
