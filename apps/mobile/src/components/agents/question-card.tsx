/* eslint-disable max-lines -- The blocking question card keeps its selection, custom-answer, and CTA presentation together. */
import { useEffect, useRef, useState } from 'react';
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
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Check } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import {
  applyBlockingCardAppearance,
  type BlockingCardSubmissionError,
  formatBlockingCardTitle,
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
  /**
   * Total number of pending blocking requests (questions + permissions).
   * The card title receives a position hint when more than one request waits.
   */
  pendingCount?: number;
};

export function QuestionCard({
  questions,
  onAnswer,
  onReject,
  isSubmitting = false,
  requestId,
  submissionError = null,
  pendingCount = 1,
}: Readonly<QuestionCardProps>) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  const [selectedOptions, setSelectedOptions] = useState<Record<number, Set<number>>>({});
  const [customSelected, setCustomSelected] = useState<Record<number, boolean>>({});
  const customInputs = useRef<Record<number, string>>({});
  const customInputRefs = useRef<Record<number, TextInput | null>>({});
  // Unread; setting it forces a re-render on every keystroke so
  // `allQuestionsAnswered` (derived from the customInputs ref) stays in sync.
  const [, setCustomHasText] = useState<Record<number, boolean>>({});

  // Accessibility presentation is derived from the shared FSM so the
  // selection logic and CTA flags stay covered by pure-logic tests.
  const presentation = getBlockingCardPresentationForKind({ kind: 'question', submissionError });

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
      // The shared cleanup cancels a pending delayed focus retry when the
      // request is replaced or the card unmounts.
      applyBlockingCardAppearance(presentationRef.current, titleRef, {
        announce: announceForA11y,
        focus: moveA11yFocus,
      }),
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

  function selectCustomOption(questionIndex: number, multiple: boolean | undefined) {
    if (customSelected[questionIndex]) {
      // Multiple choice: re-activating the checked custom answer unchecks it
      // and clears its text so the checkbox and input stay consistent.
      // Single choice behaves like a radio and stays selected.
      if (multiple) {
        customInputRefs.current[questionIndex]?.clear();
        handleCustomTextChange(questionIndex, '');
      }
      return;
    }
    if (!multiple) {
      // Single select: deselect preset options when custom is chosen.
      setSelectedOptions(p => ({ ...p, [questionIndex]: new Set<number>() }));
    }
    setCustomSelected(prev => ({ ...prev, [questionIndex]: true }));
  }

  function handleCustomTextChange(questionIndex: number, text: string) {
    customInputs.current[questionIndex] = text;
    const hasText = text.trim().length > 0;
    // Force a re-render on every keystroke so `allQuestionsAnswered` (derived
    // from the customInputs ref) stays in sync.
    setCustomHasText(prev => ({ ...prev, [questionIndex]: hasText }));
    // Auto-select custom when the user starts typing; clearing the text
    // unchecks it so it never reads as selected with no content.
    if (hasText && !customSelected[questionIndex]) {
      selectCustomOption(questionIndex, questions[questionIndex]?.multiple);
    } else if (!hasText && customSelected[questionIndex]) {
      setCustomSelected(prev => ({ ...prev, [questionIndex]: false }));
    }
  }

  function buildAnswers(): string[][] {
    return questions.map((q, qIndex) => {
      const labels = [...(selectedOptions[qIndex] ?? [])].map(
        oIndex => q.options[oIndex]?.label ?? ''
      );
      const customText = customSelected[qIndex] ? (customInputs.current[qIndex] ?? '').trim() : '';
      return customText ? [...labels, customText] : labels;
    });
  }

  function handleSubmit() {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onAnswer(buildAnswers());
  }

  function handleReject() {
    Alert.alert(
      t('agentChat.questionCard.skipQuestionsTitle'),
      t('agentChat.questionCard.skipQuestionsMessage'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('agentChat.questionCard.skip'), style: 'destructive', onPress: onReject },
      ]
    );
  }

  function handleRetrySkip() {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onReject();
  }

  const allQuestionsAnswered = buildAnswers().every(answer => answer.length > 0);
  const title = formatBlockingCardTitle(t('agentChat.questionCard.title'), pendingCount);
  const isInert = presentation.state === 'non-retryable';
  const interactionDisabled = isSubmitting || isInert;
  const submitDisabled = !allQuestionsAnswered || interactionDisabled;
  const submittingSpinner = isSubmitting ? (
    <ActivityIndicator size="small" color={colors.primaryForeground} />
  ) : null;

  return (
    <View className="mx-4 my-2 shrink overflow-hidden rounded-xl border border-border bg-card">
      <View className="border-b border-border bg-secondary px-4 py-3">
        <Text ref={titleRef} accessible accessibilityLabel={title} className="text-sm font-medium">
          {title}
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
            const isCustomActive = customSelected[qIndex] ?? false;
            return (
              <View key={qIndex} className="gap-2">
                <Text className="text-sm font-medium text-foreground">{question.question}</Text>
                {question.multiple && (
                  <Text className="text-xs text-muted-foreground">
                    {t('agentChat.questionCard.selectAllThatApply')}
                  </Text>
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
                        disabled={interactionDisabled}
                        accessibilityRole="button"
                        accessibilityLabel={
                          isSelected
                            ? t('agentChat.questionCard.optionSelected', { label: option.label })
                            : t('agentChat.questionCard.option', { label: option.label })
                        }
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
                  {question.custom !== false ? (
                    // The custom answer choice is a SIBLING radio/checkbox
                    // Pressable — a TextInput cannot expose a checked choice
                    // state, and nesting the input inside a selection
                    // Pressable would shadow it for assistive technology. The
                    // radio carries the checked semantics (radio for a single
                    // choice, checkbox beside multi-select options); pressing
                    // it also focuses the input so typing flows. The input
                    // below stays a separate, editable control.
                    <View className="gap-1">
                      <Pressable
                        accessibilityRole={question.multiple ? 'checkbox' : 'radio'}
                        accessibilityLabel={t('agentChat.questionCard.typeYourOwnAnswer')}
                        accessibilityState={{
                          checked: isCustomActive,
                          disabled: interactionDisabled,
                        }}
                        disabled={interactionDisabled}
                        onPress={() => {
                          selectCustomOption(qIndex, question.multiple);
                          customInputRefs.current[qIndex]?.focus();
                        }}
                        className={cn(
                          'min-h-11 flex-row items-center justify-between rounded-md border px-3',
                          isCustomActive
                            ? 'border-primary bg-primary'
                            : 'border-border bg-background dark:border-neutral-700 dark:bg-secondary',
                          interactionDisabled && 'opacity-50'
                        )}
                      >
                        <Text
                          className={cn(
                            'text-sm',
                            isCustomActive ? 'text-primary-foreground' : 'text-foreground'
                          )}
                        >
                          {t('agentChat.questionCard.typeYourOwnAnswer')}
                        </Text>
                        {isCustomActive ? (
                          <Check size={16} color={colors.primaryForeground} />
                        ) : null}
                      </Pressable>
                      <TextInput
                        ref={node => {
                          customInputRefs.current[qIndex] = node;
                        }}
                        defaultValue=""
                        onChangeText={text => {
                          handleCustomTextChange(qIndex, text);
                        }}
                        placeholder={t('agentChat.questionCard.typeYourOwnAnswerPlaceholder')}
                        placeholderTextColor={colors.mutedForeground}
                        editable={!interactionDisabled}
                        accessibilityLabel={t('agentChat.questionCard.typeYourOwnAnswer')}
                        accessibilityState={{ disabled: interactionDisabled }}
                        className={cn(
                          'rounded-md border px-3 py-2.5 text-sm shadow-sm shadow-black/5',
                          isCustomActive
                            ? 'border-primary bg-primary text-primary-foreground'
                            : 'border-border bg-background text-foreground dark:border-neutral-700 dark:bg-secondary',
                          interactionDisabled && 'opacity-50'
                        )}
                      />
                    </View>
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
              disabled={interactionDisabled}
            >
              <Text className="text-sm">{t('agentChat.questionCard.skip')}</Text>
            </Button>
          ) : null}
          {presentation.hasRetryCta && presentation.retryAction === 'answer' ? (
            <Button className="flex-1" onPress={handleSubmit} disabled={submitDisabled}>
              {submittingSpinner}
              <Text className={cn('text-sm', isSubmitting ? 'ml-2' : '')}>{t('common.retry')}</Text>
            </Button>
          ) : null}
          {presentation.hasRetryCta && presentation.retryAction === 'reject' ? (
            <Button className="flex-1" onPress={handleRetrySkip} disabled={interactionDisabled}>
              {submittingSpinner}
              <Text className={cn('text-sm', isSubmitting ? 'ml-2' : '')}>
                {t('agentChat.questionCard.retrySkip')}
              </Text>
            </Button>
          ) : null}
          {presentation.hasPrimaryCta ? (
            <Button className="flex-1" onPress={handleSubmit} disabled={submitDisabled}>
              {submittingSpinner}
              <Text className={cn('text-sm', isSubmitting ? 'ml-2' : '')}>
                {isSubmitting
                  ? t('agentChat.questionCard.submitting')
                  : t('agentChat.questionCard.sendAnswers')}
              </Text>
            </Button>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
