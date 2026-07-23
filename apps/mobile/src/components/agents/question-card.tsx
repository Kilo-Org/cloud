import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  type Text as RNText,
  ScrollView,
  TextInput,
  View,
} from 'react-native';
import * as Haptics from 'expo-haptics';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import {
  applyBlockingCardAppearance,
  type BlockingCardSubmissionError,
  getBlockingCardPresentationForKind,
} from '@/components/agents/blocking-card-state';
import { announceForA11y, moveA11yFocus } from '@/lib/a11y/announce';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

// Types matching the SDK's QuestionState structure
type QuestionOption = {
  label: string;
  description: string;
  mode?: string;
};

type QuestionInfo = {
  question: string;
  header: string;
  options: QuestionOption[];
  multiple?: boolean;
  custom?: boolean;
};

type QuestionCardProps = {
  questions: QuestionInfo[];
  onAnswer: (answers: string[][]) => void;
  onReject: () => void;
  isSubmitting?: boolean;
  /**
   * Identifier for the current blocking request. Drives the on-mount
   * announce + focus effect so a new question re-announces even if the
   * component instance is reused by React.
   */
  requestId: string;
  /**
   * Optional failure state from a previous answer/reject submission. The
   * component derives the rest of the presentation (CTAs, error text) from
   * this via the shared blocking-card-state FSM.
   */
  submissionError?: BlockingCardSubmissionError | null;
};

export function QuestionCard({
  questions,
  onAnswer,
  onReject,
  isSubmitting = false,
  requestId,
  submissionError = null,
}: Readonly<QuestionCardProps>) {
  const colors = useThemeColors();
  const [selectedOptions, setSelectedOptions] = useState<Record<number, Set<number>>>({});
  const [customSelected, setCustomSelected] = useState<Record<number, boolean>>({});
  const customInputs = useRef<Record<number, string>>({});
  // Unread; setting it forces a re-render on every keystroke so
  // `allQuestionsAnswered` (derived from the customInputs ref) stays in sync.
  const [, setCustomHasText] = useState<Record<number, boolean>>({});

  // Accessibility presentation is derived from the shared FSM so the
  // selection logic and CTA flags stay covered by pure-logic tests.
  const presentation = useMemo(
    () => getBlockingCardPresentationForKind({ kind: 'question', submissionError }),
    [submissionError]
  );

  // The card root wraps interactive controls, so it must NOT be an
  // accessibility element. The focus target is a non-interactive leaf title
  // inside the header; this keeps every option, input, and CTA individually
  // reachable by VoiceOver while still landing focus on the card when it
  // appears. A missing node handle on the first paint is recovered by a
  // follow-up focus inside the shared appearance helper.
  const titleRef = useRef<RNText | null>(null);
  const presentationRef = useRef(presentation);
  presentationRef.current = presentation;
  useEffect(
    () =>
      applyBlockingCardAppearance(presentationRef.current, titleRef, {
        announce: announceForA11y,
        focus: moveA11yFocus,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only announce/focus on a new request
    [requestId]
  );

  function toggleOption(questionIndex: number, optionIndex: number, multiple: boolean | undefined) {
    setSelectedOptions(prev => {
      const prevSet = prev[questionIndex];
      const current = prevSet ? new Set(prevSet) : new Set<number>();
      if (multiple) {
        if (current.has(optionIndex)) {
          current.delete(optionIndex);
        } else {
          current.add(optionIndex);
        }
      } else {
        current.clear();
        current.add(optionIndex);
      }
      return { ...prev, [questionIndex]: current };
    });
    // Single select: deselect custom when a preset option is picked
    if (!multiple) {
      setCustomSelected(prev => ({ ...prev, [questionIndex]: false }));
    }
  }

  function toggleCustom(questionIndex: number, multiple: boolean | undefined) {
    setCustomSelected(prev => {
      const wasSelected = prev[questionIndex] ?? false;
      if (!multiple && !wasSelected) {
        // Single select: deselect preset options when custom is toggled on
        setSelectedOptions(p => ({ ...p, [questionIndex]: new Set<number>() }));
      }
      return { ...prev, [questionIndex]: !wasSelected };
    });
  }

  function handleCustomTextChange(questionIndex: number, text: string) {
    customInputs.current[questionIndex] = text;
    const hasText = text.trim().length > 0;
    setCustomHasText(prev =>
      prev[questionIndex] === hasText ? prev : { ...prev, [questionIndex]: hasText }
    );
    // Auto-select custom when the user starts typing
    if (text.trim().length > 0 && !customSelected[questionIndex]) {
      const question = questions[questionIndex];
      if (!question?.multiple) {
        // Single select: deselect preset options
        setSelectedOptions(prev => ({ ...prev, [questionIndex]: new Set<number>() }));
      }
      setCustomSelected(prev => ({ ...prev, [questionIndex]: true }));
    }
  }

  function buildAnswers(): string[][] {
    return questions.map((q, qIndex) => {
      const selected = selectedOptions[qIndex];
      const labels =
        selected && selected.size > 0
          ? [...selected].map(oIndex => {
              const option = q.options[oIndex];
              return option ? option.label : '';
            })
          : [];

      const isCustom = customSelected[qIndex] ?? false;
      const customText = isCustom ? (customInputs.current[qIndex] ?? '').trim() : '';
      return customText ? [...labels, customText] : labels;
    });
  }

  function handleSubmit() {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onAnswer(buildAnswers());
  }

  function handleReject() {
    Alert.alert('Skip questions?', 'The agent will skip this step.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Skip', style: 'destructive', onPress: onReject },
    ]);
  }

  function handleRetrySkip() {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onReject();
  }

  const allQuestionsAnswered = buildAnswers().every(answer => answer.length > 0);
  const isInert = presentation.state === 'non-retryable';

  return (
    <View className="mx-4 my-2 shrink overflow-hidden rounded-xl border border-border bg-card">
      <View className="border-b border-border bg-secondary px-4 py-3">
        <Text
          ref={titleRef}
          accessible
          accessibilityLabel="Agent needs input"
          className="text-sm font-medium"
        >
          Agent needs input
        </Text>
        <Text className="mt-1 text-xs text-muted-foreground">
          {presentation.protocolExplanation}
        </Text>
      </View>

      {presentation.errorMessage ? (
        <View className="border-b border-border bg-destructive/10 px-4 py-2">
          <Text className="text-xs text-destructive">{presentation.errorMessage}</Text>
        </View>
      ) : null}

      <ScrollView className="max-h-96 shrink" keyboardShouldPersistTaps="handled">
        <View className="gap-4 p-4">
          {questions.map((question, qIndex) => {
            const allowCustom = question.custom !== false;
            const isCustomActive = customSelected[qIndex] ?? false;
            return (
              <View key={qIndex} className="gap-2">
                <Text className="text-sm font-medium text-foreground">{question.question}</Text>
                {question.multiple && (
                  <Text className="text-xs text-muted-foreground">Select all that apply</Text>
                )}
                <View className="gap-1">
                  {question.options.map((option, oIndex) => {
                    const isSelected = selectedOptions[qIndex]?.has(oIndex) ?? false;
                    return (
                      <Button
                        key={oIndex}
                        variant={isSelected ? 'default' : 'outline'}
                        size="sm"
                        onPress={() => {
                          toggleOption(qIndex, oIndex, question.multiple);
                        }}
                        disabled={isSubmitting || isInert}
                        accessibilityRole="button"
                        accessibilityLabel={`${option.label}${isSelected ? ', selected' : ''}`}
                        className={cn(
                          'h-auto justify-start py-2.5',
                          isSelected ? 'bg-primary' : 'bg-background'
                        )}
                      >
                        <Text
                          className={cn(
                            'text-left text-sm',
                            isSelected ? 'text-primary-foreground' : 'text-foreground'
                          )}
                        >
                          {option.label}
                        </Text>
                      </Button>
                    );
                  })}
                  {allowCustom ? (
                    <Pressable
                      onPress={() => {
                        toggleCustom(qIndex, question.multiple);
                      }}
                      disabled={isSubmitting || isInert}
                      accessibilityState={{
                        disabled: isSubmitting || isInert,
                        selected: isCustomActive,
                      }}
                      className={cn(
                        'flex-row items-center rounded-md border px-3 py-2.5 shadow-sm shadow-black/5',
                        isCustomActive
                          ? 'border-primary bg-primary'
                          : 'border-border bg-background dark:border-neutral-700 dark:bg-secondary',
                        (isSubmitting || isInert) && 'opacity-50'
                      )}
                    >
                      <TextInput
                        defaultValue=""
                        onChangeText={text => {
                          handleCustomTextChange(qIndex, text);
                        }}
                        placeholder="Type your own answer…"
                        placeholderTextColor={colors.mutedForeground}
                        editable={!isSubmitting && !isInert}
                        className={cn(
                          'flex-1 py-0.5 text-sm',
                          isCustomActive ? 'text-primary-foreground' : 'text-foreground'
                        )}
                      />
                    </Pressable>
                  ) : null}
                </View>
              </View>
            );
          })}
        </View>
      </ScrollView>

      {presentation.hasPrimaryCta || presentation.hasRetryCta || presentation.hasRejectCta ? (
        <View className="flex-row gap-2 border-t border-border p-3">
          {presentation.hasRejectCta ? (
            <Button
              variant="outline"
              className="flex-1"
              onPress={handleReject}
              disabled={isSubmitting || isInert}
            >
              <Text className="text-sm">Skip</Text>
            </Button>
          ) : null}
          {presentation.hasRetryCta && presentation.retryAction === 'answer' ? (
            <Button
              className="flex-1"
              onPress={handleSubmit}
              disabled={!allQuestionsAnswered || isSubmitting || isInert}
            >
              {isSubmitting ? (
                <ActivityIndicator size="small" color={colors.primaryForeground} />
              ) : null}
              <Text className={cn('text-sm', isSubmitting ? 'ml-2' : '')}>Retry</Text>
            </Button>
          ) : null}
          {presentation.hasRetryCta && presentation.retryAction === 'reject' ? (
            <Button className="flex-1" onPress={handleRetrySkip} disabled={isSubmitting || isInert}>
              {isSubmitting ? (
                <ActivityIndicator size="small" color={colors.primaryForeground} />
              ) : null}
              <Text className={cn('text-sm', isSubmitting ? 'ml-2' : '')}>Retry skip</Text>
            </Button>
          ) : null}
          {presentation.hasPrimaryCta ? (
            <Button
              className="flex-1"
              onPress={handleSubmit}
              disabled={!allQuestionsAnswered || isSubmitting || isInert}
            >
              {isSubmitting ? (
                <ActivityIndicator size="small" color={colors.primaryForeground} />
              ) : null}
              <Text className={cn('text-sm', isSubmitting ? 'ml-2' : '')}>
                {isSubmitting ? 'Submitting…' : 'Send answers'}
              </Text>
            </Button>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
