import { useTranslation } from 'react-i18next';

import { EmptyState, StateAction } from '@/components/empty-state';
import { CreditCard, GitBranch } from '@/components/ui/icons';
import { type OrganizationProfilePermission } from '@/lib/hooks/use-can-manage-profiles';
import { trialRefusalCopyKey } from '@/lib/trial-refusal';

/**
 * What the repository-defaults screen shows when the context has no bindings and
 * no form is open: the whole surface, and the header's `+` owns Add.
 *
 * A viewer who cannot add is told the rule instead of an action the screen
 * withholds. `read-only` states the rule; `resolving` states nothing, because the
 * role is not known yet and the sentence would tell an owner what an owner can.
 * A lapsed plan ends writes for a manager too, and this state is then the whole
 * surface, so it takes its own title and the refusal, plus the billing step under
 * it: that reader holds a role that can change the plan, so the state pairs the
 * step-offering sentence with the step, and the blocking state is not a dead end.
 * The generic title would read as a list nobody configured while the list cannot
 * be written at all.
 */
export function RepoBindingsEmptyState({
  permission,
  onBilling,
}: Readonly<{
  permission: OrganizationProfilePermission;
  /** Opens the billing screen where this reader can end the lapsed plan. */
  onBilling: () => void;
}>) {
  const { t } = useTranslation();
  if (permission === 'plan-ended') {
    return (
      <EmptyState
        icon={GitBranch}
        title={t('profiles.repoBindings.planEndedTitle')}
        description={t(trialRefusalCopyKey(true, 'offered'))}
        action={
          <StateAction
            label={t('organization.hub.manageBilling')}
            icon={CreditCard}
            onPress={onBilling}
          />
        }
      />
    );
  }
  // The screen withholds its sentence for a role it has not learned yet, and
  // for a personal scope, where the signed-in user can always manage.
  let description: string | undefined = undefined;
  if (permission === 'read-only') {
    description = t('profiles.organizationRoleRequired');
  } else if (permission === 'allowed') {
    description = t('profiles.repoBindings.emptyDescription');
  }
  return (
    <EmptyState
      icon={GitBranch}
      title={t('profiles.repoBindings.empty')}
      description={description}
    />
  );
}
