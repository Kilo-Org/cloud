// Horizontal event chips for the review-submit sheet. A vertical PillGroup
// is too tall for the half-detent, so these render as a wrapping row.

import * as Haptics from 'expo-haptics';
import { Pressable, View } from 'react-native';

import { RadioGroup, radioItemA11y } from '@/components/ui/radio-group';
import { Text } from '@/components/ui/text';
import { type ReviewEvent } from '@/lib/pr-review/build-submit-review-input';
import { cn } from '@/lib/utils';

const EVENT_OPTIONS: readonly { value: ReviewEvent; label: string }[] = [
  { value: 'COMMENT', label: 'Comment' },
  { value: 'REQUEST_CHANGES', label: 'Request changes' },
  { value: 'APPROVE', label: 'Approve' },
];

export function ReviewEventChips(props: {
  value: ReviewEvent;
  disabled: boolean;
  onChange: (next: ReviewEvent) => void;
}) {
  return (
    <View className="gap-1.5">
      <Text className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
        Review event
      </Text>
      <RadioGroup label="Review event" className="flex-row flex-wrap gap-2">
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
              {...radioItemA11y({ label: option.label, checked: active, disabled: props.disabled })}
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
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </RadioGroup>
    </View>
  );
}
