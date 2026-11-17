import { type Href } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { ChevronDown } from '@/components/ui/icons';
import { Keyboard, Pressable, View } from 'react-native';

import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { FIELD_TRIGGER_BODY_CLASS, FIELD_TRIGGER_FRAME_CLASS } from '@/lib/a11y/tap-target';
import { i18n } from '@/i18n';
import {
  cloudAgentTargetLabel,
  formatInstanceTarget,
  formatInstanceValue,
} from '@/lib/instance-target-label';
import { useSinglePushRoute } from '@/lib/hooks/use-single-push-route';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { type InstancePickerInstance } from '@/lib/picker-bridge';
import { instancePickerSlot, UNFENCED_ROUTE_KEY } from '@/lib/route-registry';
import { cn } from '@/lib/utils';

type InstanceSelectorProps = {
  /**
   * `null` means the user has the default Cloud Agent target selected, or —
   * with `pendingComputer` — the computer target with no computer bound yet.
   * Any non-null value is a live `kilo remote` CLI instance the picker
   * chose.
   */
  value: InstancePickerInstance | null;
  /**
   * The list the picker will open with. The route owns the data; the
   * selector just hands it across the bridge. When the list is empty the
   * selector still opens (the picker shows the empty state + Refresh).
   */
  instances: InstancePickerInstance[];
  isLoading: boolean;
  /**
   * The computer target is selected with no computer bound yet (the tour's
   * computer path with zero connected computers): the closed selector names
   * that state instead of the Cloud Agent default.
   */
  pendingComputer?: boolean;
  onChange: (value: InstancePickerInstance | null) => void;
  disabled?: boolean;
};

function selectorValue({
  value,
  pendingComputer = false,
}: {
  value: InstancePickerInstance | null;
  pendingComputer?: boolean;
}): string {
  if (value) {
    return formatInstanceValue(value);
  }
  if (pendingComputer) {
    return i18n.t('agentChat.instancePicker.noCliInstances');
  }
  return cloudAgentTargetLabel();
}

export function InstanceSelector({
  value,
  instances,
  isLoading,
  pendingComputer,
  onChange,
  disabled = false,
}: Readonly<InstanceSelectorProps>) {
  const pushOnce = useSinglePushRoute();
  const colors = useThemeColors();
  const { t } = useTranslation();

  // The list decides what "Run on" says, so an empty field is loading until it
  // settles. A bound target keeps its name while a refetch runs: the same
  // instance list opens the picker either way.
  if (isLoading && value === null) {
    return (
      <View
        accessible
        accessibilityLabel={t('agentChat.instancePicker.runOnAccessibility', {
          label: t('common.loading'),
        })}
        accessibilityState={{ busy: true }}
        className={FIELD_TRIGGER_FRAME_CLASS}
      >
        <View className={cn(FIELD_TRIGGER_BODY_CLASS, 'justify-between')}>
          {/* The branch row's loading bar: a name-width line, so the field
              reads as the row it becomes. `bg-muted-soft` because the default
              `bg-skeleton-fill` equals this frame's `bg-secondary` in the light
              palette, where the bar would paint nothing. */}
          <Skeleton className="h-4 w-1/3 bg-muted-soft" />
          <ChevronDown size={14} color={colors.mutedForeground} />
        </View>
      </View>
    );
  }

  // The Cloud Agent default is always selectable, even when the list is
  // empty — only the "open the picker" path is gated.
  const canOpenPicker = !disabled;
  const label = selectorValue({ value, pendingComputer });
  // The value line names the computer alone, but a screen reader hears the
  // whole target: the project is where the session will run.
  const accessibleTarget = value === null ? label : formatInstanceTarget(value);
  // A target is selected in every state but the unbound computer: the Cloud
  // Agent default is a real value, not a placeholder, so it takes the same
  // foreground ink as a bound instance. Placeholder ink would read as "nothing
  // chosen yet" beside the account value above it.
  const isPlaceholder = value === null && pendingComputer;

  function handlePress() {
    if (!canOpenPicker) {
      return;
    }
    instancePickerSlot.set(UNFENCED_ROUTE_KEY, {
      instances,
      currentValue: value,
      pendingComputer: pendingComputer && value === null,
      onSelect: onChange,
    });
    // See ModelSelector: the sheet never re-anchors after the keyboard hides,
    // so the keyboard must be down before this push.
    Keyboard.dismiss();
    pushOnce('/(app)/agent-chat/instance-picker' as Href);
  }

  return (
    <Pressable
      onPress={handlePress}
      disabled={!canOpenPicker}
      accessibilityRole="button"
      accessibilityLabel={t('agentChat.instancePicker.runOnAccessibility', {
        label: accessibleTarget,
      })}
      accessibilityState={{ disabled: !canOpenPicker }}
      className={cn(FIELD_TRIGGER_FRAME_CLASS, !canOpenPicker && 'opacity-50')}
    >
      <View className={cn(FIELD_TRIGGER_BODY_CLASS, 'justify-between')}>
        <Text
          className={cn(
            'min-w-0 flex-1 text-base',
            isPlaceholder ? 'text-muted-foreground' : 'text-foreground'
          )}
          numberOfLines={1}
          // The value is a computer name, read from the start, so it takes the
          // ordinary tail cut. The project it runs in is the Folder field's job
          // below the row, and repeating it cut the name itself on a compact
          // screen.
          ellipsizeMode="tail"
        >
          {label}
        </Text>
        <ChevronDown size={14} color={colors.mutedForeground} />
      </View>
    </Pressable>
  );
}
