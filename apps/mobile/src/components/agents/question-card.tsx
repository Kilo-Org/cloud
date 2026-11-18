/* eslint-disable max-lines -- The blocking question card keeps its selection, custom-answer, and CTA presentation together. */
import { useEffect, useRef, useState } from 'react';
import {
  Pressable,
  ScrollView,
  type TextInput,
  type TextInstance,
  type TextStyle,
  View,
} from 'react-native';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import * as Haptics from 'expo-haptics';
import { impactHaptic } from '@/lib/haptics';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Check } from '@/components/ui/icons';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { useConfirmDialog } from '@/components/ui/dialog';
import {
  applyBlockingCardAppearance,
  type BlockingCardSubmissionError,
  formatBlockingCardTitle,
  getBlockingCardPresentationForKind,
} from '@/components/agents/blocking-card-state';
import { announceForA11y, requestA11yFocus } from '@/lib/a11y/announce';
import { ROW_TARGET_CLASS } from '@/lib/a11y/tap-target';
import { useMutedDisabledInk, useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';
import {
  answerLabels,
  isAnswered,
  isCustomSelected,
  MULTI_NONE,
  type MultiAnswer,
  pressSingleChoice,
  pressSingleCustom,
  SINGLE_NONE,
  type SingleAnswer,
  toggleMultiChoice,
  toggleMultiCustom,
  typeMultiCustom,
  typeSingleCustom,
} from './question-card-answer';

/**
 * Start alignment for an option's stacked label and description. `Button`
 * publishes a centred label through its text class context, so a description
 * that wraps would centre every line under a title that starts at the column
 * edge. `auto` leaves the lines to the paragraph direction the shared Text
 * already names, which is the start edge in either interface direction, and it
 * has to be a style: the class from that context would otherwise win, and this
 * build drops the logical `text-start` utility.
 */
const OPTION_TEXT_ALIGN = { textAlign: 'auto' } as const satisfies TextStyle;

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
  const mutedDisabledInk = useMutedDisabledInk();
  const { t } = useTranslation();
  const { confirm, dialog } = useConfirmDialog();
  const [singleAnswers, setSingleAnswers] = useState<Record<number, SingleAnswer>>({});
  const [multiAnswers, setMultiAnswers] = useState<Record<number, MultiAnswer>>({});
  const customInputs = useRef<Record<number, string>>({});
  const customInputRefs = useRef<Record<number, TextInput | null>>({});
  // Derived from the custom text ref so Send and the progress line follow every
  // keystroke without the ref itself being read during render.
  const [customHasText, setCustomHasText] = useState<Record<number, boolean>>({});
  // Bumped when a transition drops the custom answer, so the uncontrolled field
  // remounts empty. Typing never bumps it, so focus survives an edit.
  const [customReset, setCustomReset] = useState<Record<number, number>>({});

  // Accessibility presentation is derived from the shared FSM so the
  // selection logic and CTA flags stay covered by pure-logic tests.
  const presentation = getBlockingCardPresentationForKind({ kind: 'question', submissionError });

  // The card root wraps interactive controls, so it must NOT be an
  // accessibility element. The focus target is a non-interactive leaf title
  // inside the header; this keeps every option, input, and CTA individually
  // reachable by VoiceOver while still landing focus on the card when it
  // appears. A missing node handle on the first paint is recovered by a
  // follow-up focus inside the shared appearance helper.
  const titleRef = useRef<TextInstance | null>(null);
  const presentationRef = useRef(presentation);
  presentationRef.current = presentation;
  useEffect(
    () =>
      // The shared cleanup cancels a pending delayed focus retry when the
      // request is replaced or the card unmounts.
      applyBlockingCardAppearance(presentationRef.current, titleRef, {
        announce: announceForA11y,
        focus: requestA11yFocus,
      }),
    [requestId]
  );

  function answerOf(question: QuestionInfo, index: number): SingleAnswer | MultiAnswer {
    return question.multiple
      ? (multiAnswers[index] ?? MULTI_NONE)
      : (singleAnswers[index] ?? SINGLE_NONE);
  }

  function clearCustomAnswer(index: number) {
    customInputs.current[index] = '';
    setCustomHasText(prev => ({ ...prev, [index]: false }));
    setCustomReset(prev => ({ ...prev, [index]: (prev[index] ?? 0) + 1 }));
  }

  function toggleOption(questionIndex: number, optionIndex: number, multiple: boolean | undefined) {
    if (multiple) {
      setMultiAnswers(prev => ({
        ...prev,
        [questionIndex]: toggleMultiChoice(prev[questionIndex] ?? MULTI_NONE, optionIndex),
      }));
      return;
    }
    const current = singleAnswers[questionIndex] ?? SINGLE_NONE;
    setSingleAnswers(prev => ({
      ...prev,
      [questionIndex]: pressSingleChoice(prev[questionIndex] ?? SINGLE_NONE, optionIndex),
    }));
    // A preset press replaces the custom answer, so the field's text goes too:
    // text the card would not submit may not stay on screen.
    if (isCustomSelected(current)) {
      clearCustomAnswer(questionIndex);
    }
  }

  function selectCustomOption(questionIndex: number, multiple: boolean | undefined) {
    if (multiple) {
      const current = multiAnswers[questionIndex] ?? MULTI_NONE;
      const next = toggleMultiCustom(current);
      setMultiAnswers(prev => ({ ...prev, [questionIndex]: next }));
      // Re-activating the checked custom answer unchecks it; its text goes with
      // it so the checkbox and the field stay consistent.
      if (isCustomSelected(current)) {
        clearCustomAnswer(questionIndex);
      }
      return;
    }
    // A single-choice radio stays selected on a re-press, keeping its text.
    setSingleAnswers(prev => ({
      ...prev,
      [questionIndex]: pressSingleCustom(prev[questionIndex] ?? SINGLE_NONE),
    }));
  }

  function handleCustomTextChange(questionIndex: number, text: string) {
    customInputs.current[questionIndex] = text;
    const hasText = text.trim().length > 0;
    setCustomHasText(prev => ({ ...prev, [questionIndex]: hasText }));
    // Typing selects the custom answer; clearing the text unchecks it so it
    // never reads as selected with no content.
    if (questions[questionIndex]?.multiple) {
      setMultiAnswers(prev => ({
        ...prev,
        [questionIndex]: typeMultiCustom(prev[questionIndex] ?? MULTI_NONE, hasText),
      }));
      return;
    }
    setSingleAnswers(prev => ({
      ...prev,
      [questionIndex]: typeSingleCustom(prev[questionIndex] ?? SINGLE_NONE, hasText),
    }));
  }

  function buildAnswers(): string[][] {
    return questions.map((question, index) =>
      answerLabels(
        answerOf(question, index),
        customHasText[index] ? (customInputs.current[index] ?? '') : '',
        question.options
      )
    );
  }

  function handleSubmit() {
    impactHaptic(Haptics.ImpactFeedbackStyle.Light);
    onAnswer(buildAnswers());
  }

  function handleReject() {
    confirm({
      title: t('agentChat.questionCard.skipQuestionsTitle'),
      message: t('agentChat.questionCard.skipQuestionsMessage'),
      confirmLabel: t('agentChat.questionCard.skip'),
      onConfirm: onReject,
    });
  }

  function handleRetrySkip() {
    impactHaptic(Haptics.ImpactFeedbackStyle.Light);
    onReject();
  }

  const answeredCount = questions.reduce(
    (count, question, index) =>
      count +
      (isAnswered(
        answerOf(question, index),
        customHasText[index] ? (customInputs.current[index] ?? '') : ''
      )
        ? 1
        : 0),
    0
  );
  const allQuestionsAnswered = answeredCount === questions.length;
  const title = formatBlockingCardTitle(t('agentChat.questionCard.title'), pendingCount);
  const isInert = presentation.state === 'non-retryable';
  const interactionDisabled = isSubmitting || isInert;
  const submitDisabled = !allQuestionsAnswered || interactionDisabled;
  // The spinner only shows while submitting, and every button that carries it
  // is disabled then, so it sits on the muted fill a disabled primary paints.
  const submittingSpinner = isSubmitting ? (
    <ActivityIndicator size="small" color={mutedDisabledInk} />
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
        <View className="border-b border-border bg-danger-tile-bg px-4 py-2">
          <Text className="text-xs text-destructive">{presentation.errorMessage}</Text>
        </View>
      ) : null}

      <ScrollView className="max-h-96 shrink" keyboardShouldPersistTaps="handled">
        <View className="gap-4 p-4">
          {questions.map((question, qIndex) => {
            const answer = answerOf(question, qIndex);
            const isCustomActive = isCustomSelected(answer);
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
                    const isSelected =
                      answer.kind === 'one'
                        ? answer.choice === oIndex
                        : (answer.kind === 'presets' || answer.kind === 'presets-and-custom') &&
                          answer.chosen.has(oIndex);
                    // The description is content, not an action hint: TalkBack
                    // (Android) reads the node's hint text, never the tooltip
                    // React Native fills from `accessibilityHint`, so a hint
                    // would leave the subtitle unannounced. Join it into the
                    // accessible name, the way the Kilo Pass card does.
                    const optionLabel = option.description
                      ? `${option.label}, ${option.description}`
                      : option.label;
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
                            ? t('agentChat.questionCard.optionSelected', { label: optionLabel })
                            : t('agentChat.questionCard.option', { label: optionLabel })
                        }
                        className={cn(
                          'h-auto justify-start py-2.5',
                          isSelected ? 'bg-primary' : 'bg-background'
                        )}
                      >
                        {/*
                          The agent may attach an explanation to a choice; the
                          CLI, web, and extension all show it as a muted
                          subtitle under the label. Stack the two lines so the
                          label stays the prominent line and the description
                          reads as supporting text.
                        */}
                        <View className="flex-1 flex-col items-start gap-0.5">
                          <Text
                            className={cn(
                              'text-sm',
                              isSelected ? 'text-primary-foreground' : 'text-foreground'
                            )}
                            style={OPTION_TEXT_ALIGN}
                          >
                            {option.label}
                          </Text>
                          {option.description ? (
                            <Text
                              className={cn(
                                'text-xs',
                                isSelected
                                  ? 'text-primary-foreground opacity-70'
                                  : 'text-muted-foreground'
                              )}
                              style={OPTION_TEXT_ALIGN}
                            >
                              {option.description}
                            </Text>
                          ) : null}
                        </View>
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
                          ROW_TARGET_CLASS,
                          'flex-row items-center justify-between rounded-md border px-3',
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
                      <Input
                        key={`custom-${qIndex}-${customReset[qIndex] ?? 0}`}
                        ref={node => {
                          customInputRefs.current[qIndex] = node;
                        }}
                        defaultValue=""
                        onChangeText={text => {
                          handleCustomTextChange(qIndex, text);
                        }}
                        placeholder={t('agentChat.questionCard.typeYourOwnAnswerPlaceholder')}
                        // The active field swaps its fill to `bg-primary`, so the
                        // placeholder follows the fill's foreground like the
                        // typed text and the option label do; the muted grey is
                        // painted for the plain background and is unreadable on
                        // the olive fill.
                        placeholderTextColor={
                          isCustomActive ? colors.primaryForeground : colors.mutedForeground
                        }
                        editable={!interactionDisabled}
                        accessibilityLabel={t('agentChat.questionCard.typeYourOwnAnswer')}
                        accessibilityState={{ disabled: interactionDisabled }}
                        className={cn(
                          // The shared single-line box supplies the touch
                          // floor (`min-h-[44px]`, never a fixed height);
                          // dropping `py-2.5` lets the box own the vertical
                          // geometry, and every other token stays.
                          'rounded-md border pl-3 pr-3 text-sm shadow-sm shadow-[#0000000D]',
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
        <View className="flex-col gap-2 border-t border-border p-3">
          {questions.length > 1 ? (
            <Text
              accessibilityLiveRegion="polite"
              className="text-center text-xs text-muted-foreground"
            >
              {t('agentChat.questionCard.answerProgress', {
                answered: answeredCount,
                total: questions.length,
              })}
            </Text>
          ) : null}
          {presentation.hasRejectCta ? (
            <Button
              variant="outline"
              className="w-full"
              onPress={handleReject}
              disabled={interactionDisabled}
            >
              <Text className="shrink text-center text-sm">{t('agentChat.questionCard.skip')}</Text>
            </Button>
          ) : null}
          {presentation.hasRetryCta && presentation.retryAction === 'answer' ? (
            <Button className="w-full" onPress={handleSubmit} disabled={submitDisabled}>
              {submittingSpinner}
              <Text className="shrink text-center text-sm">{t('common.retry')}</Text>
            </Button>
          ) : null}
          {presentation.hasRetryCta && presentation.retryAction === 'reject' ? (
            <Button className="w-full" onPress={handleRetrySkip} disabled={interactionDisabled}>
              {submittingSpinner}
              <Text className="shrink text-center text-sm">
                {t('agentChat.questionCard.retrySkip')}
              </Text>
            </Button>
          ) : null}
          {presentation.hasPrimaryCta ? (
            <Button className="w-full" onPress={handleSubmit} disabled={submitDisabled}>
              {submittingSpinner}
              <Text className="shrink text-center text-sm">
                {isSubmitting
                  ? t('agentChat.questionCard.submitting')
                  : t('agentChat.questionCard.sendAnswers')}
              </Text>
            </Button>
          ) : null}
        </View>
      ) : null}
      {dialog}
    </View>
  );
}
