import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { ROW_TARGET_CLASS } from '@/lib/a11y/tap-target';
import { cn } from '@/lib/utils';

import { type SessionAutoApproveState } from './session-auto-approve';

/**
 * Per-session auto-approve toggle: title + subtitle on the left, a native
 * `Switch` on the right, on the shared row frame inside the caller's
 * `RowGroup`. A selection haptic is a capability both iOS and Android have, so
 * there is one implementation: the screen that owns the session state fires the
 * single `selectionHaptic()` for the commit, and this row adds no
 * platform-specific module of its own. Disabled and labelled "unavailable" for
 * a session that cannot receive permission asks.
 *
 * The shared `PreferenceRow` paints a leading 30pt `IconTile`, which this row
 * has never had and the session header has no icon to give it; the switch row
 * therefore keeps this file's own frame.
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
      className={cn(ROW_TARGET_CLASS, 'flex-row items-center gap-3 px-4 py-3')}
    >
      <View className="min-w-0 flex-1">
        <Text className="text-sm font-medium">{title}</Text>
        <Text variant="caption" className="mt-0.5">
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
        onValueChange={onValueChange}
      />
    </View>
  );
}
