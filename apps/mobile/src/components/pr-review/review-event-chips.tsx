// Horizontal event chips for the review-submit sheet. A vertical PillGroup
// is too tall for the half-detent, so these render as a wrapping row.

import * as Haptics from 'expo-haptics';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { RadioGroup, radioItemA11y } from '@/components/ui/radio-group';
import { Text } from '@/components/ui/text';
import { type ReviewEvent } from '@/lib/pr-review/build-submit-review-input';
import { cn } from '@/lib/utils';

const EVENT_OPTIONS: readonly { value: ReviewEvent; labelKey: string }[] = [
  { value: 'COMMENT', labelKey: 'prReview.eventChips.comment' },
  { value: 'REQUEST_CHANGES', labelKey: 'prReview.eventChips.requestChanges' },
  { value: 'APPROVE', labelKey: 'prReview.eventChips.approve' },
];

export function ReviewEventChips(props: {
  value: ReviewEvent;
  disabled: boolean;
  onChange: (next: ReviewEvent) => void;
}) {
  const { t } = useTranslation();
  return (
    <View className="gap-1.5">
      <Text className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
        {t('prReview.eventChips.label')}
      </Text>
      <RadioGroup label={t('prReview.eventChips.label')} className="flex-row flex-wrap gap-2">
        {EVENT_OPTIONS.map(option => {
          const active = props.value === option.value;
          return (
            <Pressable
              key={option.value}
              disabled={props.disabled}
              onPress={() => {
                void Haptics.selectionAsync();
                props.onChange(option.value);
              }}
              {...radioItemA11y({
                label: t(option.labelKey),
                checked: active,
                disabled: props.disabled,
              })}
              className={cn(
                'min-h-11 items-center justify-center rounded-full border px-4 py-2 active:opacity-70',
                active ? 'border-primary bg-primary' : 'bg-secondary',
                !active && (props.disabled ? 'border-hair-soft' : 'border-border')
              )}
            >
              <Text
                className={cn(
                  'text-sm font-medium',
                  active ? 'text-primary-foreground' : 'text-foreground',
                  !active && props.disabled && 'text-muted-foreground'
                )}
              >
                {t(option.labelKey)}
              </Text>
            </Pressable>
          );
        })}
      </RadioGroup>
    </View>
  );
}
