import { useTranslation } from 'react-i18next';
import { useState } from 'react';
import { View } from 'react-native';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';

import { RefusalStatus } from '@/components/refusal-status';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { ChoiceRow } from '@/components/ui/choice-row';
import { RadioGroup } from '@/components/ui/radio-group';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { reviewerSaveFailure } from '@/lib/code-reviewer-save-error';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { usePopOnce } from '@/lib/navigation/pop-once';
import { CODE_REVIEWER_HOME_PATH } from '@/lib/profile-agent-navigation';
import { isTrialExpiredRefusal } from '@/lib/server-error-copy';
import { useCanManageBilling, useTrialRefusalAction } from '@/lib/trial-refusal';
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
  /**
   * The organization the save is made against, or null for a personal scope.
   * The role it resolves to decides the explanation a refused save shows: the
   * organization trial gate's copy offers the plan step to a billing role.
   */
  organizationId?: string | null;
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
  organizationId,
}: Readonly<OptionListProps<T, TSaveResult>>) {
  const popOnce = usePopOnce();
  const colors = useThemeColors();
  const { t } = useTranslation();
  const canManageBilling = useCanManageBilling(organizationId);
  const [pending, setPending] = useState<T | null>(null);
  // The rejection is kept raw rather than as its mapped copy: the explanation
  // and the step under it are re-derived on every render, so the role that
  // settles after the refusal paints both from the same answer.
  const [failure, setFailure] = useState<{ error: unknown; option: T } | null>(null);
  const retryInFlight = failure?.option === pending;
  const report =
    failure === null
      ? null
      : reviewerSaveFailure(failure.error, t('codeReviewer.configSaveFailed'), canManageBilling);
  const billingAction = useTrialRefusalAction(
    failure !== null && isTrialExpiredRefusal(failure.error),
    organizationId
  );

  const handleSelect = async (option: T) => {
    setPending(option);
    // Retrying keeps its explanation on screen — the row's busy state belongs
    // to that failure, and the message must not blink off and back for a
    // refusal the server answers in milliseconds. Any other selection retires
    // the previous failure.
    setFailure(current => (current?.option === option ? current : null));
    try {
      await onSelect(option);
      // A Back pressed while the save was in flight already left this screen,
      // and a Back handled while the save's own dismissal runs is this
      // screen's leave too; either way the completion must not pop the screen
      // beneath.
      popOnce();
    } catch (error) {
      // The save hook already surfaced the failure (toast + cache rollback) —
      // keep the screen up, clear the busy state, and hand the row to the
      // inline explanation below.
      setFailure({ error, option });
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
        {failure !== null && report !== null && (
          <View className="mt-4 rounded-lg bg-warn-tile-bg p-4">
            {/* `RefusalStatus` owns the announcement (the card carried a live
                region of its own before), and the tile's own ink stays: the
                refusal is a configuration refusal, not a destructive one. */}
            <RefusalStatus
              message={report.message}
              action={billingAction}
              className="text-sm font-medium text-foreground"
            />
            {report.retryable && (
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
