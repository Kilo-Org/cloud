import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Text } from '@/components/ui/text';

/**
 * Shown while the agent waits on a permission request this app cannot read. No
 * consent card is rendered, because a card would describe a scope the boundary
 * never parsed; the CLI can still answer the request, so the notice points the
 * user there instead of leaving the run stalled without explanation.
 */
export function PermissionUnreadableNotice() {
  const { t } = useTranslation();

  return (
    <View
      accessible
      accessibilityRole="alert"
      className="mx-4 my-2 rounded-xl border border-warn-tile-border bg-warn-tile-bg p-4"
    >
      <Text className="text-sm font-medium text-warn">
        {t('agentChat.permissionCard.unreadableTitle')}
      </Text>
      <Text className="mt-1 text-xs text-muted-foreground">
        {t('agentChat.permissionCard.unreadableBody')}
      </Text>
    </View>
  );
}
