import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, View } from 'react-native';

import { Text } from '@/components/ui/text';
import { announceForA11y } from '@/lib/a11y/announce';

/**
 * Shown while the agent waits on a permission request this app cannot read. No
 * consent card is rendered, because a card would describe a scope the boundary
 * never parsed; the CLI can still answer the request, so the notice points the
 * user there instead of leaving the run stalled without explanation.
 *
 * The notice appears without any user action, so a screen reader has to learn
 * about it. Android reads the polite live region as the node is added; iOS has
 * no live region, so the same copy is announced once there. Announcing on both
 * would read it twice on Android.
 */
export function PermissionUnreadableNotice() {
  const { t } = useTranslation();
  const announcement = t('agentChat.permissionCard.unreadableBody');

  useEffect(() => {
    if (Platform.OS !== 'android') {
      announceForA11y(announcement);
    }
  }, [announcement]);

  return (
    <View
      accessible
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      className="mx-4 my-2 rounded-xl border border-warn-tile-border bg-warn-tile-bg p-4"
    >
      <Text className="text-sm font-medium text-warn">
        {t('agentChat.permissionCard.unreadableTitle')}
      </Text>
      <Text className="mt-1 text-xs text-muted-foreground">{announcement}</Text>
    </View>
  );
}
