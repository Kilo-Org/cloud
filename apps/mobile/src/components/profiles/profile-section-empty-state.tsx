import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { EmptyState, StateAction } from '@/components/empty-state';
import { ProfileManageSlot } from '@/components/profiles/profile-manage-slot';
import { CreditCard, type LucideIcon } from '@/components/ui/icons';
import { type OrganizationProfilePermission } from '@/lib/hooks/use-can-manage-profiles';
import { trialRefusalCopyKey } from '@/lib/trial-refusal-copy';
import { useBillingAction } from '@/lib/trial-refusal';

/**
 * What a profile section shows when it has nothing to list: the caller's state,
 * with its one action filled by the same slot the section's footer uses, and a
 * lapsed plan stated as its own title.
 *
 * A lapsed plan ends every write for a manager too, so the title says the plan
 * is what is missing and the state offers the billing step; the section's own
 * icon would name the wrong problem (a repository or a file glyph does not
 * signal a billing one). The step-offering sentence pairs with that step, since
 * a `plan-ended` reader is always a billing role.
 */
export function ProfileSectionEmptyState({
  permission,
  organizationId,
  icon,
  title,
  description,
  action,
  placement,
}: Readonly<{
  permission: OrganizationProfilePermission;
  /** The organization whose billing screen the plan state opens. */
  organizationId?: string;
  icon: LucideIcon;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  placement?: 'top';
}>) {
  const { t } = useTranslation();
  const billing = useBillingAction(organizationId);
  if (permission === 'plan-ended') {
    return (
      <EmptyState
        icon={CreditCard}
        title={t('common.planRequiredTitle')}
        description={t(trialRefusalCopyKey(true, 'offered'))}
        placement={placement}
        action={
          billing ? (
            <StateAction
              label={billing.label}
              icon={CreditCard}
              onPress={() => {
                billing.onPress();
              }}
            />
          ) : undefined
        }
      />
    );
  }
  // A state with nothing to offer fills no action slot: the slot carries its own
  // gap, and an empty wrapper would reserve it for a control the caller withheld.
  const sectionAction = action ? (
    <ProfileManageSlot permission={permission} organizationId={organizationId}>
      {action}
    </ProfileManageSlot>
  ) : undefined;
  return (
    <EmptyState
      icon={icon}
      title={title}
      description={description}
      placement={placement}
      action={sectionAction}
    />
  );
}
