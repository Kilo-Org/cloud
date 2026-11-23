import { Pressable, View } from 'react-native';
import { type Href, useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { ChevronDown } from '@/components/ui/icons';

import { getBuiltinModeLabelKey, getModeIcon } from '@/components/agents/mode-options';
import {
  type AgentMode,
  dedupeCustomModeOptions,
  isBuiltinAgentMode,
  type ModeOption,
  normalizeAgentMode,
} from '@/components/agents/mode-normalize';
import { Text } from '@/components/ui/text';
import {
  CHIP_HIT_SLOP,
  FIELD_TRIGGER_BODY_CLASS,
  FIELD_TRIGGER_FRAME_CLASS,
} from '@/lib/a11y/tap-target';
import { useSinglePushRoute } from '@/lib/hooks/use-single-push-route';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { parseParam } from '@/lib/route-params';
import { modePickerSlot, UNFENCED_ROUTE_KEY } from '@/lib/route-registry';
import { cn } from '@/lib/utils';

export type { AgentMode };

type ModeSelectorProps = {
  value: AgentMode;
  onChange: (mode: AgentMode) => void;
  disabled?: boolean;
  customOptions?: ModeOption[];
  /**
   * `chip` (default) is the composer's pill beside the model chip; `field` is
   * a form's select box, the shared trigger frame the repository and model
   * fields use, so a form shows one picker style. The caller labels the field.
   */
  presentation?: 'chip' | 'field';
};

export function ModeSelector({
  value,
  onChange,
  disabled = false,
  customOptions = [],
  presentation = 'chip',
}: Readonly<ModeSelectorProps>) {
  const pushOnce = useSinglePushRoute();
  const colors = useThemeColors();
  const { t } = useTranslation();
  const { 'session-id': rawSessionId } = useLocalSearchParams<{ 'session-id'?: string }>();
  const selectedValue = normalizeAgentMode(value);
  const customOptionsDeduped = dedupeCustomModeOptions(customOptions);
  const customMatch = customOptionsDeduped.find(option => option.value === selectedValue);
  // An empty label means no loaded option names this mode, so the chip falls
  // back to the generic label rather than printing the slug.
  const customLabel = customMatch?.label ?? '';
  const selectedLabel = isBuiltinAgentMode(selectedValue)
    ? t(getBuiltinModeLabelKey(selectedValue) ?? '')
    : customLabel || t('agentChat.modeSelector.customMode');
  const ModeIcon = getModeIcon(selectedValue);

  function handlePress() {
    if (disabled) {
      return;
    }
    const routeKey = parseParam(rawSessionId) ?? UNFENCED_ROUTE_KEY;
    modePickerSlot.set(routeKey, {
      currentValue: selectedValue,
      onSelect: onChange,
      customOptions,
    });
    pushOnce(`/(app)/agent-chat/mode-picker?routeKey=${encodeURIComponent(routeKey)}` as Href);
  }

  const pressableProps = {
    onPress: handlePress,
    disabled,
    accessibilityRole: 'button' as const,
    accessibilityLabel: t('agentChat.modeSelector.accessibility', { label: selectedLabel }),
    accessibilityState: { disabled },
  };
  // The label stays at full theme contrast; a disabled picker dims only its
  // icon so the text keeps the WCAG AA 4.5:1 ratio (D2).
  const modeIcon = (
    <ModeIcon size={14} color={disabled ? colors.mutedForeground : colors.foreground} />
  );
  // The field presentation draws the value in the shared select box, so its
  // line takes the field-select value size; the chip keeps its own `text-sm`.
  const modeLabel = (
    <Text
      className={cn(
        'font-medium text-foreground',
        presentation === 'field' ? 'text-base' : 'text-sm'
      )}
      numberOfLines={1}
    >
      {selectedLabel}
    </Text>
  );

  if (presentation === 'field') {
    return (
      <Pressable
        {...pressableProps}
        className={cn(FIELD_TRIGGER_FRAME_CLASS, !disabled && 'active:opacity-70')}
      >
        <View className={cn(FIELD_TRIGGER_BODY_CLASS, 'justify-between')}>
          <View className="min-w-0 shrink flex-row items-center gap-1.5">
            {modeIcon}
            {modeLabel}
          </View>
          <ChevronDown size={16} color={colors.mutedForeground} />
        </View>
      </Pressable>
    );
  }

  return (
    <Pressable
      {...pressableProps}
      // The pill's own 27.81pt frame is the visual; the vertical slop carries
      // its touch region past the 44pt design target without growing the row.
      hitSlop={CHIP_HIT_SLOP}
      className="shrink-0 flex-row items-center gap-1.5 rounded-full bg-secondary px-3 py-1.5 active:opacity-70"
    >
      {modeIcon}
      {modeLabel}
      <ChevronDown size={14} color={colors.mutedForeground} />
    </Pressable>
  );
}
