import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { FilterChip } from '@/components/ui/filter-chip';
import { FormFieldLabel } from '@/components/ui/form-field-label';
import { thinkingEffortLabel } from '@/lib/hooks/use-available-models';

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
      <FormFieldLabel label={t('agentChat.modelSelector.thinkingEffort')} />
      <View className="flex-row flex-wrap gap-2">
        {variants.map(option => {
          const selected = value === option;
          return (
            <FilterChip
              key={option}
              selected={selected}
              label={thinkingEffortLabel(option)}
              disabled={disabled}
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
            />
          );
        })}
      </View>
    </View>
  );
}
