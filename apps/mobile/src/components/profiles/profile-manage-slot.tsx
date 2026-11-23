import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { OrganizationPlanNotice } from '@/components/organization/plan-notice';
import { Text } from '@/components/ui/text';
import { type OrganizationProfilePermission } from '@/lib/hooks/use-can-manage-profiles';
import { trialRefusalCopyKey } from '@/lib/trial-refusal-copy';
import { useBillingAction } from '@/lib/trial-refusal';

/**
 * The manage-action slot of a profile section: the same place in the layout
 * holds either the caller's action or the statement that names why it is
 * absent.
 *
 * An organization member sees no add, edit or delete control, and a section
 * without one of those reads as broken unless it says why. `read-only` states
 * the reason in the action's own slot, so a member and a manager read the same
 * screen in the same place. `plan-ended` paints the shared titled plan notice —
 * the alert mark, `Plan required`, the explanation and the billing step —
 * because the server refuses every write, and a control that is always refused
 * reads as broken. `resolving` renders neither: the role is not known yet, so
 * an action would be refused by the server for a member and the statement would
 * tell an owner they cannot act on what they can. `allowed` renders the
 * caller's action, and nothing when the caller has none.
 *
 * A `plan-ended` reader is always a role that can change the plan:
 * `useOrganizationProfilePermission` returns it only after
 * `canManageOrganization(role)` passes, and `ORGANIZATION_MANAGE_ROLES` is
 * `['owner', 'admin']`, a subset of `ORGANIZATION_BILLING_ROLES`. The
 * explanation is therefore the `'offered'` copy, which pairs with the step
 * `useBillingAction` returns for that reader.
 *
 * The block stretches across the slot: this slot is also painted inside the
 * `action` cell of an `EmptyState`, whose column centers its children, so
 * without the stretch the notice would shrink to its longest line.
 */
export function ProfileManageSlot({
  permission,
  organizationId,
  children,
}: Readonly<{
  permission: OrganizationProfilePermission;
  /** The organization whose billing screen the plan refusal opens. */
  organizationId?: string;
  children?: ReactNode;
}>) {
  const { t } = useTranslation();
  const billingAction = useBillingAction(organizationId);
  if (permission === 'plan-ended') {
    return (
      <OrganizationPlanNotice
        className="self-stretch"
        title={t('common.planRequiredTitle')}
        message={t(trialRefusalCopyKey(true, 'offered'))}
        action={billingAction}
      />
    );
  }
  if (permission === 'allowed') {
    return <>{children}</>;
  }
  if (permission === 'resolving') {
    return null;
  }
  return (
    <View className="items-center">
      <Text variant="muted" className="text-center">
        {t('profiles.organizationRoleRequired')}
      </Text>
    </View>
  );
}
