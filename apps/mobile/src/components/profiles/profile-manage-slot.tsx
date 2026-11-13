import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Text } from '@/components/ui/text';
import { type OrganizationProfilePermission } from '@/lib/hooks/use-can-manage-profiles';

/**
 * The manage-action slot of a profile section: the same place in the layout
 * holds either the caller's action or the sentence that names who may change
 * the profile.
 *
 * An organization member sees no add, edit or delete control, and a section
 * without one of those reads as broken unless it says why. `read-only` states
 * the reason in the action's own slot, so a member and a manager read the same
 * screen in the same place. `resolving` renders neither: the role is not known
 * yet, so an action would be refused by the server for a member and the
 * sentence would tell an owner they cannot act on what they can. `allowed`
 * renders the caller's action, and nothing when the caller has none.
 */
export function ProfileManageSlot({
  permission,
  children,
}: Readonly<{
  permission: OrganizationProfilePermission;
  children?: ReactNode;
}>) {
  const { t } = useTranslation();
  if (permission === 'allowed') {
    return <>{children}</>;
  }
  if (permission !== 'read-only') {
    return null;
  }
  return (
    <View className="items-center px-2">
      <Text variant="muted" className="text-center">
        {t('profiles.organizationRoleRequired')}
      </Text>
    </View>
  );
}
