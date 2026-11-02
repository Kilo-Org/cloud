import { useTranslation } from 'react-i18next';
import { useState } from 'react';
import { View } from 'react-native';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';

import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { ChoiceRow } from '@/components/ui/choice-row';
import { RadioGroup } from '@/components/ui/radio-group';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { reviewerSaveFailure, type ReviewerSaveFailure } from '@/lib/code-reviewer-save-error';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { usePopWhenFocused } from '@/lib/navigation/pop-when-focused';
import { CODE_REVIEWER_HOME_PATH } from '@/lib/profile-agent-navigation';
import { cn } from '@/lib/utils';

type OptionListProps<T extends string, TSaveResult> = {
  title: string;
  options: readonly T[];
  selected: T | undefined;
  /** Must resolve/reject once the save actually completes — the screen
   * navigates back only on confirmed success. */
  onSelect: (value: T) => Promise<TSaveResult>;
  /** Optional per-option row label; defaults to the raw option value. */
  labels?: Readonly<Record<T, string>>;
  /** Optional per-option caption below the label. */
  descriptions?: Readonly<Record<T, string>>;
  /** Disables every row, e.g. while the config backing `selected` is still loading. */
  disabled?: boolean;
};

/** Full-screen single-select list. Selecting saves, then pops the screen only once the save confirms. */
export function OptionList<T extends string, TSaveResult>({
  title,
  options,
  selected,
  onSelect,
  labels,
  descriptions,
  disabled,
}: Readonly<OptionListProps<T, TSaveResult>>) {
  const popWhenFocused = usePopWhenFocused();
  const colors = useThemeColors();
  const { t } = useTranslation();
  const [pending, setPending] = useState<T | null>(null);
  const [failure, setFailure] = useState<(ReviewerSaveFailure & { option: T }) | null>(null);
  const retryInFlight = failure?.option === pending;

  const handleSelect = async (option: T) => {
    setPending(option);
    // Retrying keeps its explanation on screen — the row's busy state belongs
    // to that failure, and the message must not blink off and back for a
    // refusal the server answers in milliseconds. Any other selection retires
    // the previous failure.
    setFailure(current => (current?.option === option ? current : null));
    try {
      await onSelect(option);
      // A Back pressed while the save was in flight already left this screen;
      // popping again would remove the screen beneath it.
      popWhenFocused();
    } catch (error) {
      // The save hook already surfaced the failure (toast + cache rollback) —
      // keep the screen up, clear the busy state, and hand the row to the
      // inline explanation below.
      setFailure({
        ...reviewerSaveFailure(error, t('codeReviewer.configSaveFailed')),
        option,
      });
    } finally {
      setPending(null);
    }
  };

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={title} backFallback={CODE_REVIEWER_HOME_PATH} />
      <TabScreenScrollView className="flex-1" contentContainerClassName="px-6 pt-4">
        <RadioGroup label={title}>
          {options.map(option => (
            <View key={option} className="relative">
              <ChoiceRow
                label={labels?.[option] ?? option}
                description={descriptions?.[option]}
                selected={selected === option}
                disabled={Boolean(disabled) || pending !== null}
                busy={pending === option}
                onPress={() => {
                  void handleSelect(option);
                }}
                className="border-b-[0.5px] border-hair-soft"
              />
              {pending === option && (
                <View className="absolute inset-y-0 right-0 justify-center" pointerEvents="none">
                  <ActivityIndicator size="small" color={colors.mutedForeground} />
                </View>
              )}
            </View>
          ))}
        </RadioGroup>
        {failure !== null && (
          <View className="mt-4 rounded-lg bg-warn-tile-bg p-4" accessibilityLiveRegion="polite">
            <Text className="text-sm font-medium">{failure.message}</Text>
            {failure.retryable && (
              <Button
                variant="outline"
                size="sm"
                className={cn(STATE_ACTION_CLASS, 'mt-3 self-start')}
                loading={retryInFlight}
                accessibilityLabel={t('common.retry')}
                onPress={() => {
                  void handleSelect(failure.option);
                }}
              >
                <Text>{t('common.retry')}</Text>
              </Button>
            )}
          </View>
        )}
      </TabScreenScrollView>
    </View>
  );
}
