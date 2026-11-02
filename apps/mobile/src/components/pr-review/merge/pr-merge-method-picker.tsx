import { selectionHaptic } from '@/lib/haptics';
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
                selectionHaptic();
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
                // The selected chip is a selection state, not a call to action:
                // light fills with `primary`, dark with the muted `selection`
                // olive, because dark's `primary` is the brand yellow
                // (#ffdd00), which glares as a full pill on the near-black
                // page. Dark's `selection` is the same olive hue lifted for the
                // dark page (global.css), so it still stands 3.6:1 off the
                // background. The Merge button keeps the brand fill.
                active && 'border-primary bg-primary dark:border-selection dark:bg-selection',
                !active && isDisabled && 'border-hair-soft bg-secondary',
                !active && !isDisabled && 'border-border bg-secondary'
              )}
            >
              <Text
                className={cn(
                  'text-sm font-medium',
                  active && 'text-primary-foreground dark:text-selection-foreground',
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
