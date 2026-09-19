import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text';
import { thinkingEffortLabel } from '@/lib/hooks/use-available-models';
import { cn } from '@/lib/utils';

type AgentVariantPickerProps = Readonly<{
  /** The catalogue variants published for the currently typed model. */
  variants: readonly string[];
  value: string;
  disabled?: boolean;
  onChange: (variant: string) => void;
}>;

/**
 * Tap list of a model's thinking-effort variants, mirroring the web editor's
 * `VariantCombobox`. The caller renders it only when the typed model publishes
 * variants, so an unavailable model list never shows an empty control.
 */
export function AgentVariantPicker({
  variants,
  value,
  disabled,
  onChange,
}: Readonly<AgentVariantPickerProps>) {
  const { t } = useTranslation();
  return (
    <View className="gap-1.5">
      <Text className="text-sm font-medium text-foreground">
        {t('agentChat.modelSelector.thinkingEffort')}
      </Text>
      <View className="flex-row flex-wrap gap-2">
        {variants.map(option => {
          const selected = value === option;
          return (
            <Pressable
              key={option}
              className={cn(
                'min-h-11 items-center justify-center rounded-full px-4 active:opacity-70',
                selected ? 'bg-foreground' : 'bg-secondary'
              )}
              disabled={disabled}
              accessibilityRole="radio"
              accessibilityState={{ checked: selected }}
              accessibilityLabel={
                selected
                  ? t('agentChat.modelSelector.thinkingEffortSelected', {
                      label: thinkingEffortLabel(option),
                    })
                  : t('agentChat.modelSelector.thinkingEffortAccessibility', {
                      label: thinkingEffortLabel(option),
                    })
              }
              onPress={() => {
                onChange(option);
              }}
            >
              <Text
                className={cn(
                  'text-sm font-medium',
                  selected ? 'text-background' : 'text-foreground'
                )}
              >
                {thinkingEffortLabel(option)}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
