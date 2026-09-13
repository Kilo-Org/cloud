import * as Haptics from 'expo-haptics';
import { Switch, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Text } from '@/components/ui/text';

import { type SessionAutoApproveState } from './session-auto-approve';

/**
 * Per-session auto-approve toggle: title + subtitle on the left, a native
 * `Switch` on the right with a selection haptic on change. Disabled and
 * labelled "unavailable" for a session that cannot receive permission asks.
 */
export function SessionAutoApproveRow({
  state,
  onValueChange,
}: Readonly<{
  state: SessionAutoApproveState;
  onValueChange: (value: boolean) => void;
}>) {
  const { t } = useTranslation();
  const title = t('agentChat.autoApprove.title');
  return (
    <View
      testID="session-auto-approve-row"
      className="flex-row items-center justify-between rounded-lg bg-secondary p-4"
    >
      <View className="flex-1 pr-3">
        <Text className="text-sm font-medium">{title}</Text>
        <Text variant="muted" className="text-xs">
          {state === 'unavailable'
            ? t('agentChat.autoApprove.unavailable')
            : t('agentChat.autoApprove.description')}
        </Text>
      </View>
      <Switch
        testID="session-auto-approve-switch"
        accessibilityLabel={title}
        value={state === 'on'}
        disabled={state === 'unavailable'}
        onValueChange={next => {
          void Haptics.selectionAsync();
          onValueChange(next);
        }}
      />
    </View>
  );
}
