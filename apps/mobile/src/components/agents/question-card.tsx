/* eslint-disable max-lines -- The blocking question card keeps its selection, custom-answer, and CTA presentation together. */
import { useEffect, useRef, useState } from 'react';
import { ScrollView, type TextInstance, type TextStyle, View } from 'react-native';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import * as Haptics from 'expo-haptics';
import { impactHaptic } from '@/lib/haptics';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
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
import { useMutedDisabledInk } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';
import {
  answerLabels,
  isAnswered,
  isCustomSelected,
  MULTI_NONE,
  type MultiAnswer,
  pressSingleChoice,
  SINGLE_NONE,
  type SingleAnswer,
  toggleMultiChoice,
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
  /**
   * An answer the person already typed somewhere else (a notification reply),
   * offered as the first question's custom answer. Applied once, and only onto
   * an empty field, so it never replaces text typed here.
   */
  initialAnswer?: string | null;
};

export function QuestionCard({
  questions,
  onAnswer,
  onReject,
  isSubmitting = false,
  requestId,
  submissionError = null,
  pendingCount = 1,
  initialAnswer = null,
}: Readonly<QuestionCardProps>) {
  const mutedDisabledInk = useMutedDisabledInk();
  const { t } = useTranslation();
  const { confirm, dialog } = useConfirmDialog();
  const [singleAnswers, setSingleAnswers] = useState<Record<number, SingleAnswer>>({});
  const [multiAnswers, setMultiAnswers] = useState<Record<number, MultiAnswer>>({});
  const customInputs = useRef<Record<number, string>>({});
  // Derived from the custom text ref so Send and the progress line follow every
  // keystroke without the ref itself being read during render.
  const [customHasText, setCustomHasText] = useState<Record<number, boolean>>({});
  // Bumped when a transition drops the custom answer, so the uncontrolled field
  // remounts empty. Typing never bumps it, so focus survives an edit.
  const [customReset, setCustomReset] = useState<Record<number, number>>({});
  // The text an applied `initialAnswer` painted into the field. The box is
  // uncontrolled, so the value only paints at mount; the seed rides the key
  // above to remount it with this default.
  const [customSeed, setCustomSeed] = useState<Record<number, string>>({});

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

  // A remembered answer from a notification reply arrives before the person
  // has typed here. Apply it exactly as typing does, once, and only onto an
  // empty field: text typed on this card belongs to the person.
  const appliedInitialAnswer = useRef<string | null>(null);
  useEffect(() => {
    const text = initialAnswer ?? '';
    if (text.trim().length === 0) {
      appliedInitialAnswer.current = null;
      return;
    }
    if (appliedInitialAnswer.current === text) {
      return;
    }
    if ((customInputs.current[0] ?? '').length > 0) {
      return;
    }
    const first = questions[0];
    // A question that takes no custom answer has no field to seed, and its
    // preset answer is the only thing it would submit.
    if (first === undefined || first.custom === false) {
      return;
    }
    appliedInitialAnswer.current = text;
    customInputs.current[0] = text;
    setCustomHasText(prev => ({ ...prev, 0: true }));
    setCustomSeed(prev => ({ ...prev, 0: text }));
    setCustomReset(prev => ({ ...prev, 0: (prev[0] ?? 0) + 1 }));
    if (first.multiple) {
      setMultiAnswers(prev => ({ ...prev, 0: typeMultiCustom(prev[0] ?? MULTI_NONE, true) }));
      return;
    }
    setSingleAnswers(prev => ({ ...prev, 0: typeSingleCustom(prev[0] ?? SINGLE_NONE, true) }));
  }, [initialAnswer, questions]);

  function answerOf(question: QuestionInfo, index: number): SingleAnswer | MultiAnswer {
    return question.multiple
      ? (multiAnswers[index] ?? MULTI_NONE)
      : (singleAnswers[index] ?? SINGLE_NONE);
  }

  function clearCustomAnswer(index: number) {
    customInputs.current[index] = '';
    setCustomHasText(prev => ({ ...prev, [index]: false }));
    setCustomSeed(prev => ({ ...prev, [index]: '' }));
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
  // is disabled then, so it sits on the disabled primary fill.
  const submittingSpinner = isSubmitting ? (
    <ActivityIndicator size="small" color={mutedDisabledInk} />
  ) : null;

  return (
    <Card className="mx-4 my-2 shrink">
      <View className="gap-1">
        <Text ref={titleRef} accessible accessibilityLabel={title} variant="heading">
          {title}
        </Text>
        <Text variant="caption">{presentation.protocolExplanation}</Text>
      </View>

      {presentation.errorMessage ? (
        <Text variant="caption" className="text-destructive">
          {presentation.errorMessage}
        </Text>
      ) : null}

      <ScrollView className="max-h-96 shrink" keyboardShouldPersistTaps="handled">
        <View className="gap-3">
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
                          {/* A selected option keeps the brand fill while the
                              card is submitting or unavailable, so its label
                              must re-apply the brand ink for each scheme. The
                              shared disabled face puts `dark:text-ink2` on a
                              label, and Tailwind emits that after the base ink;
                              without `dark:text-primary-foreground` here the
                              dark label would paint on the brand fill at about
                              1.3:1. */}
                          <Text
                            className={cn(
                              'text-sm',
                              isSelected
                                ? 'text-primary-foreground dark:text-primary-foreground'
                                : 'text-foreground'
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
                                  ? 'text-primary-foreground opacity-70 dark:text-primary-foreground'
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
                    // The custom answer is one control, the field itself, drawn
                    // as one more option: the outlined box of an unchosen option
                    // and the filled one of a chosen option. A separate "Type
                    // your own answer" choice above it repeated the field's own
                    // placeholder and wore a box unlike the options beside it.
                    // Typing chooses the answer and clearing the text drops it,
                    // so the field needs no second control; it states its choice
                    // the way the preset options do, in its accessible name.
                    <Input
                      key={`custom-${qIndex}-${customReset[qIndex] ?? 0}`}
                      defaultValue={customSeed[qIndex] ?? ''}
                      onChangeText={text => {
                        handleCustomTextChange(qIndex, text);
                      }}
                      placeholder={t('agentChat.questionCard.typeYourOwnAnswerPlaceholder')}
                      editable={!interactionDisabled}
                      accessibilityLabel={
                        isCustomActive
                          ? t('agentChat.questionCard.optionSelected', {
                              label: t('agentChat.questionCard.typeYourOwnAnswer'),
                            })
                          : t('agentChat.questionCard.option', {
                              label: t('agentChat.questionCard.typeYourOwnAnswer'),
                            })
                      }
                      accessibilityState={{ disabled: interactionDisabled }}
                      className={cn(
                        // The option buttons' border and fill: the outline of an
                        // unchosen option, the filled `default` of a chosen one.
                        'rounded-md border pl-3 pr-3 text-sm',
                        isCustomActive
                          ? 'border-primary bg-primary text-primary-foreground shadow-sm shadow-[#0000000D]'
                          : 'border-input bg-background text-foreground',
                        interactionDisabled && 'opacity-50'
                      )}
                    />
                  ) : null}
                </View>
              </View>
            );
          })}
        </View>
      </ScrollView>

      {presentation.hasPrimaryCta || presentation.hasRetryCta || presentation.hasRejectCta ? (
        <View className="flex-col gap-2 border-t-[0.5px] border-hair-soft pt-3">
          {questions.length > 1 ? (
            <Text accessibilityLiveRegion="polite" variant="caption" className="text-center">
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
    </Card>
  );
}
