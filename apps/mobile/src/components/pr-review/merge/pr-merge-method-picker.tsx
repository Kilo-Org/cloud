import * as Haptics from 'expo-haptics';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { RadioGroup, radioItemA11y } from '@/components/ui/radio-group';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import {
  type AllowedMergeMethod,
  prMergeDescription,
} from '@/lib/pr-review/merge/merge-blocked-reasons';
import { type MergeMethodOption } from '@/components/pr-review/merge/pr-merge-icons';

export function MethodPicker({
  methodOptions,
  method,
  isDisabled,
  onChange,
}: Readonly<{
  methodOptions: MergeMethodOption[];
  method: AllowedMergeMethod;
  isDisabled: boolean;
  onChange: (next: AllowedMergeMethod) => void;
}>) {
  const { t } = useTranslation();
  return (
    <View className="gap-1.5">
      <Text className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
        {t('prReview.merge.methodLabel')}
      </Text>
      <RadioGroup label={t('prReview.merge.methodLabel')} className="flex-row flex-wrap gap-2">
        {methodOptions.map(option => {
          const active = method === option.value;
          // Long labels stay readable via accessibilityLabel; chip shows short text.
          return (
            <Pressable
              key={option.value}
              disabled={isDisabled}
              onPress={() => {
                void Haptics.selectionAsync();
                onChange(option.value);
              }}
              {...radioItemA11y({
                label: option.accessibilityLabel,
                checked: active,
                disabled: isDisabled,
              })}
              accessibilityHint={prMergeDescription(option.value)}
              className={cn(
                'min-h-11 items-center justify-center rounded-full border px-4 py-2 active:opacity-70',
                active && 'border-primary bg-primary',
                !active && isDisabled && 'border-hair-soft bg-secondary',
                !active && !isDisabled && 'border-border bg-secondary'
              )}
            >
              <Text
                className={cn(
                  'text-sm font-medium',
                  active && 'text-primary-foreground',
                  !active && isDisabled && 'text-muted-foreground',
                  !active && !isDisabled && 'text-foreground'
                )}
              >
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </RadioGroup>
    </View>
  );
}
