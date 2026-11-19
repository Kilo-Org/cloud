import { FlashList } from '@shopify/flash-list';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { ScrollView, View, type ViewStyle } from 'react-native';
import { useTranslation } from 'react-i18next';

import {
  type BuiltinModeOption,
  getBuiltinModeDescriptionKey,
  getBuiltinModeLabelKey,
  getModeIcon,
  MODE_OPTIONS,
} from '@/components/agents/mode-options';
import { type AgentMode } from '@/components/agents/mode-selector';
import {
  dedupeCustomModeOptions,
  ensureSelectedCustomOption,
  type ModeOption,
} from '@/components/agents/mode-normalize';
import { PickerSheet } from '@/components/picker-sheet';
import { ChoiceRow } from '@/components/ui/choice-row';
import { SectionHeader } from '@/components/ui/section-header';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { parseParam } from '@/lib/route-params';
import { modePickerSlot, UNFENCED_ROUTE_KEY, useRouteRegistry } from '@/lib/route-registry';

// FlashList takes `style`/`contentContainerStyle` (never `className`), so the
// list's `flex-1 bg-background` classes become the list style plus the themed
// background. The picker sheet renders its own scroll container
// (`scrollable={false}`), so the list fills the sheet's body.
const listStyle = { flex: 1 } satisfies ViewStyle;

export default function ModePickerScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  const { t } = useTranslation();
  const { routeKey: rawRouteKey } = useLocalSearchParams<{ routeKey?: string }>();
  const routeKey = parseParam(rawRouteKey) ?? UNFENCED_ROUTE_KEY;
  useRouteRegistry(routeKey);
  // Lazy init reads the slot synchronously on first render — no effect, no
  // "No options available" flash before a later effect populates state.
  const [bridge] = useState(() => modePickerSlot.get(routeKey));

  function close() {
    router.back();
  }

  function handleSelect(mode: AgentMode) {
    bridge?.onSelect(mode);
    modePickerSlot.clear(routeKey);
    router.back();
  }

  if (!bridge) {
    return (
      <PickerSheet
        title={t('agentChat.modePicker.title')}
        onDone={close}
        onCancel={close}
        scrollable={false}
        topInset="never"
        expired
      />
    );
  }

  const currentValue = bridge.currentValue;
  const custom = ensureSelectedCustomOption(
    dedupeCustomModeOptions(bridge.customOptions ?? []),
    currentValue
  );

  function renderItem({ item }: { item: BuiltinModeOption | ModeOption }) {
    const Icon = getModeIcon(item.value);
    const selected = item.value === currentValue;
    const isBuiltin = 'labelKey' in item;
    const label = isBuiltin
      ? t(getBuiltinModeLabelKey(item.value) ?? '')
      : item.label || t('agentChat.modeSelector.customMode');
    const description = isBuiltin
      ? t(getBuiltinModeDescriptionKey(item.value) ?? '')
      : item.description;

    return (
      <ChoiceRow
        className="border-b-[0.5px] border-hair-soft"
        selected={selected}
        accessibleName={
          description !== ''
            ? t('agentChat.modePicker.modeLabel', { label, description })
            : t('agentChat.modeSelector.accessibility', { label })
        }
        onPress={() => {
          handleSelect(item.value);
        }}
      >
        <View className="min-w-0 flex-1 flex-row items-center gap-3">
          <Icon size={18} color={colors.foreground} />
          <View className="min-w-0 flex-1">
            <Text className="text-sm font-medium" numberOfLines={1}>
              {label}
            </Text>
            {description !== '' && (
              <Text variant="muted" className="mt-0.5 text-xs">
                {description}
              </Text>
            )}
          </View>
        </View>
      </ChoiceRow>
    );
  }

  return (
    <PickerSheet
      title={t('agentChat.modePicker.title')}
      onDone={close}
      onCancel={close}
      scrollable={false}
      topInset="never"
    >
      {custom.length === 0 ? (
        <FlashList
          nestedScrollEnabled
          style={[listStyle, { backgroundColor: colors.background }]}
          data={MODE_OPTIONS}
          keyExtractor={item => item.value}
          renderItem={renderItem}
        />
      ) : (
        <ScrollView nestedScrollEnabled className="flex-1 bg-background">
          {MODE_OPTIONS.map(item => (
            <View key={item.value}>{renderItem({ item })}</View>
          ))}
          <SectionHeader inset label={t('agentChat.modePicker.customModes')} />
          {custom.map(item => (
            <View key={item.value}>{renderItem({ item })}</View>
          ))}
        </ScrollView>
      )}
    </PickerSheet>
  );
}
