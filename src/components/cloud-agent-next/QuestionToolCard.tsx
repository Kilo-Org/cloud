'use client';

import { useState, useCallback } from 'react';
import { useAtomValue } from 'jotai';
import { ChevronDown, Loader2, XCircle, Check, Send, X, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useRawTRPCClient } from '@/lib/trpc/utils';
import {
  questionRequestIdsAtom,
  currentSessionIdAtom,
  sessionOrganizationIdAtom,
} from './store/atoms';
import type { ToolPart } from './types';
import type { QuestionInfo } from '@/types/opencode.gen';

type QuestionToolCardProps = {
  toolPart: ToolPart;
};

type QuestionInput = {
  questions: QuestionInfo[];
};

type QuestionMetadata = {
  answers?: string[][];
  truncated?: boolean;
};

function getStatusIndicator(status: 'pending' | 'running' | 'completed' | 'error') {
  switch (status) {
    case 'error':
      return <XCircle className="h-4 w-4 shrink-0 text-red-500" />;
    case 'completed':
      return <span className="text-muted-foreground shrink-0 text-xs">question</span>;
    case 'pending':
    case 'running':
    default:
      return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-blue-500" />;
  }
}

/** Read-only view of a completed question's answers */
function CompletedQuestionContent({
  question,
  answers,
  showHeader = true,
}: {
  question: QuestionInfo;
  answers?: string[];
  showHeader?: boolean;
}) {
  const hasAnswers = answers && answers.length > 0;
  const customAnswers = hasAnswers
    ? answers.filter(a => !question.options?.some(opt => opt.label === a))
    : [];

  return (
    <div className="space-y-2">
      {showHeader && question.header && (
        <div className="text-muted-foreground text-xs font-medium">{question.header}</div>
      )}
      <div className="text-sm">{question.question}</div>

      {question.options && question.options.length > 0 && (
        <div className="space-y-1">
          {question.options.map((option, idx) => {
            const isSelected = hasAnswers && answers.includes(option.label);
            return (
              <div
                key={idx}
                className={cn(
                  'rounded-md px-2 py-1 text-xs',
                  isSelected ? 'bg-primary/20 border-primary/50 border' : 'bg-muted/30'
                )}
              >
                <div className="flex items-center gap-1">
                  {isSelected && <Check className="h-3 w-3 text-green-500" />}
                  <span className={cn('font-medium', isSelected && 'text-primary')}>
                    {option.label}
                  </span>
                </div>
                {option.description && (
                  <div className="text-muted-foreground mt-0.5">{option.description}</div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {customAnswers.length > 0 && (
        <div className="space-y-1">
          {customAnswers.map((answer, idx) => (
            <div
              key={idx}
              className="flex items-center gap-1 rounded-md border border-blue-500/50 bg-blue-500/20 px-2 py-1 text-xs"
            >
              <Check className="h-3 w-3 text-green-500" />
              <span className="font-medium">{answer}</span>
              <span className="text-muted-foreground text-[10px]">(custom)</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Interactive view for answering a question */
function InteractiveQuestionContent({
  question,
  selectedLabels,
  customInput,
  customSelected,
  onToggleOption,
  onCustomInputChange,
  onToggleCustom,
  showHeader = true,
}: {
  question: QuestionInfo;
  selectedLabels: string[];
  customInput: string;
  customSelected: boolean;
  onToggleOption: (label: string) => void;
  onCustomInputChange: (value: string) => void;
  onToggleCustom: () => void;
  showHeader?: boolean;
}) {
  const isMultiple = question.multiple === true;
  const allowCustom = question.custom !== false;

  return (
    <div className="space-y-3">
      {showHeader && question.header && (
        <div className="text-muted-foreground text-xs font-medium">{question.header}</div>
      )}
      <div className="text-sm font-medium">{question.question}</div>

      <div className="space-y-1.5">
        {question.options?.map((option, idx) => {
          const isSelected = selectedLabels.includes(option.label);
          return (
            <button
              key={idx}
              type="button"
              onClick={() => onToggleOption(option.label)}
              className={cn(
                'w-full rounded-md border px-3 py-2 text-left text-xs transition-colors',
                isSelected
                  ? 'bg-primary/15 border-primary/60 ring-primary/30 ring-1'
                  : 'border-muted bg-muted/20 hover:bg-muted/40 hover:border-muted-foreground/30'
              )}
            >
              <div className="flex items-center gap-2">
                <div
                  className={cn(
                    'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                    isMultiple ? 'rounded' : 'rounded-full',
                    isSelected
                      ? 'bg-primary border-primary text-primary-foreground'
                      : 'border-muted-foreground/40'
                  )}
                >
                  {isSelected && <Check className="h-2.5 w-2.5" />}
                </div>
                <span className={cn('font-medium', isSelected && 'text-primary')}>
                  {option.label}
                </span>
              </div>
              {option.description && (
                <div className="text-muted-foreground mt-1 pl-6">{option.description}</div>
              )}
            </button>
          );
        })}

        {allowCustom && (
          <div
            role="button"
            tabIndex={-1}
            onClick={() => {
              if (!customSelected) onToggleCustom();
            }}
            className={cn(
              'w-full rounded-md border px-3 py-2 text-left text-xs transition-colors',
              customSelected
                ? 'bg-primary/15 border-primary/60 ring-primary/30 ring-1'
                : 'border-muted bg-muted/20 hover:bg-muted/40 hover:border-muted-foreground/30'
            )}
          >
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={e => {
                  e.stopPropagation();
                  onToggleCustom();
                }}
                className={cn(
                  'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                  isMultiple ? 'rounded' : 'rounded-full',
                  customSelected
                    ? 'bg-primary border-primary text-primary-foreground'
                    : 'border-muted-foreground/40'
                )}
              >
                {customSelected && <Check className="h-2.5 w-2.5" />}
              </button>
              <input
                type="text"
                value={customInput}
                onClick={e => e.stopPropagation()}
                onChange={e => onCustomInputChange(e.target.value)}
                placeholder="Type your own answer..."
                className="placeholder:text-muted-foreground/50 min-w-0 flex-1 bg-transparent font-medium outline-none"
              />
            </div>
          </div>
        )}
      </div>

      {isMultiple && (
        <div className="flex gap-2 text-[10px]">
          <span className="bg-muted/50 text-muted-foreground rounded px-1.5 py-0.5">
            Select multiple
          </span>
        </div>
      )}
    </div>
  );
}

function QuestionTab({
  question,
  answers,
  isActive,
  onClick,
  index,
  total,
}: {
  question: QuestionInfo;
  answers?: string[];
  isActive: boolean;
  onClick: () => void;
  index: number;
  total: number;
}) {
  const hasAnswers = answers && answers.length > 0;

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'shrink-0 rounded-md px-2 py-1 text-xs transition-colors',
        isActive
          ? 'bg-primary text-primary-foreground'
          : 'bg-muted/50 text-muted-foreground hover:bg-muted'
      )}
    >
      {total > 1 ? question.header || `Q${index + 1}` : question.header || 'Question'}
      {hasAnswers && <Check className="ml-1 inline h-3 w-3" />}
    </button>
  );
}

export function QuestionToolCard({ toolPart }: QuestionToolCardProps) {
  const state = toolPart.state;
  const input = state.input as QuestionInput;
  const questions = input.questions || [];
  const isRunning = state.status === 'running';

  const [isExpanded, setIsExpanded] = useState(isRunning);
  const [activeTab, setActiveTab] = useState(0);
  const [selectedAnswers, setSelectedAnswers] = useState<string[][]>(() => questions.map(() => []));
  const [customInputs, setCustomInputs] = useState<string[]>(() => questions.map(() => ''));
  const [customSelected, setCustomSelected] = useState<boolean[]>(() => questions.map(() => false));
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const trpcClient = useRawTRPCClient();
  const questionRequestIds = useAtomValue(questionRequestIdsAtom);
  const sessionId = useAtomValue(currentSessionIdAtom);
  const organizationId = useAtomValue(sessionOrganizationIdAtom);

  const requestId = toolPart.callID ? questionRequestIds.get(toolPart.callID) : undefined;

  // Get answers from metadata for completed state
  const completedAnswers: string[][] =
    state.status === 'completed'
      ? ((state.metadata as QuestionMetadata | undefined)?.answers ?? [])
      : [];

  const error = state.status === 'error' ? state.error : undefined;
  const questionCount = questions.length;
  const answeredCount = completedAnswers.filter(a => a && a.length > 0).length;

  const headerText =
    questionCount === 1
      ? questions[0]?.header || 'Question'
      : `${questionCount} questions${answeredCount > 0 ? ` (${answeredCount} answered)` : ''}`;

  const handleToggleOption = useCallback(
    (questionIndex: number, label: string) => {
      const question = questions[questionIndex];
      const isMultiple = question?.multiple === true;

      setSelectedAnswers(prev => {
        const updated = [...prev];
        const current = updated[questionIndex] ?? [];

        if (isMultiple) {
          updated[questionIndex] = current.includes(label)
            ? current.filter(l => l !== label)
            : [...current, label];
        } else {
          updated[questionIndex] = current.includes(label) ? [] : [label];
        }
        return updated;
      });

      // Single-select: picking an option deselects custom
      if (!isMultiple) {
        setCustomSelected(prev => {
          const updated = [...prev];
          updated[questionIndex] = false;
          return updated;
        });
      }
    },
    [questions]
  );

  const handleToggleCustom = useCallback(
    (questionIndex: number) => {
      const question = questions[questionIndex];
      const isMultiple = question?.multiple === true;

      setCustomSelected(prev => {
        const updated = [...prev];
        const wasSelected = updated[questionIndex] ?? false;
        updated[questionIndex] = !wasSelected;
        return updated;
      });

      // Single-select: selecting custom deselects options
      if (!isMultiple) {
        setSelectedAnswers(prev => {
          const updated = [...prev];
          updated[questionIndex] = [];
          return updated;
        });
      }
    },
    [questions]
  );

  const handleCustomInputChange = useCallback(
    (questionIndex: number, value: string) => {
      setCustomInputs(prev => {
        const updated = [...prev];
        updated[questionIndex] = value;
        return updated;
      });
      // Auto-select custom when user types
      if (value.length > 0) {
        setCustomSelected(prev => {
          if (prev[questionIndex]) return prev;
          const updated = [...prev];
          updated[questionIndex] = true;
          return updated;
        });
        // Single-select: auto-selecting custom deselects options
        const question = questions[questionIndex];
        if (question?.multiple !== true) {
          setSelectedAnswers(prev => {
            if ((prev[questionIndex] ?? []).length === 0) return prev;
            const updated = [...prev];
            updated[questionIndex] = [];
            return updated;
          });
        }
      }
    },
    [questions]
  );

  /** Compute effective answers for a given question index */
  const getEffectiveAnswers = useCallback(
    (questionIndex: number) => {
      const labels = selectedAnswers[questionIndex] ?? [];
      const isCustom = customSelected[questionIndex] ?? false;
      const custom = isCustom ? (customInputs[questionIndex] ?? '').trim() : '';
      return custom ? [...labels, custom] : [...labels];
    },
    [selectedAnswers, customSelected, customInputs]
  );

  const hasAnyAnswer = questions.some((_, i) => getEffectiveAnswers(i).length > 0);

  const handleSubmit = useCallback(async () => {
    if (!requestId || !sessionId || isSubmitting) return;

    const answers: string[][] = questions.map((_, i) => getEffectiveAnswers(i));

    setIsSubmitting(true);
    setSubmitError(null);

    try {
      if (organizationId) {
        await trpcClient.organizations.cloudAgentNext.answerQuestion.mutate(
          { sessionId, questionId: requestId, answers, organizationId },
          { context: { skipBatch: true } }
        );
      } else {
        await trpcClient.cloudAgentNext.answerQuestion.mutate(
          { sessionId, questionId: requestId, answers },
          { context: { skipBatch: true } }
        );
      }
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to submit answer');
    } finally {
      setIsSubmitting(false);
    }
  }, [
    requestId,
    sessionId,
    organizationId,
    questions,
    getEffectiveAnswers,
    isSubmitting,
    trpcClient,
  ]);

  const handleDismiss = useCallback(async () => {
    if (!requestId || !sessionId || isSubmitting) return;

    setIsSubmitting(true);
    setSubmitError(null);

    try {
      if (organizationId) {
        await trpcClient.organizations.cloudAgentNext.rejectQuestion.mutate(
          { sessionId, questionId: requestId, organizationId },
          { context: { skipBatch: true } }
        );
      } else {
        await trpcClient.cloudAgentNext.rejectQuestion.mutate(
          { sessionId, questionId: requestId },
          { context: { skipBatch: true } }
        );
      }
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to dismiss question');
    } finally {
      setIsSubmitting(false);
    }
  }, [requestId, sessionId, organizationId, isSubmitting, trpcClient]);

  // Running state: always expanded, interactive
  if (isRunning) {
    return (
      <div className="border-primary/40 bg-muted/30 rounded-md border border-l-4">
        {/* Header */}
        <div className="flex items-center gap-2 px-3 py-2">
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-blue-500" />
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{headerText}</span>
        </div>

        <div className="border-muted border-t px-3 py-2">
          {/* Tabs for multiple questions */}
          {questionCount > 1 && (
            <div className="mb-3 flex gap-1 overflow-x-auto pb-1">
              {questions.map((q, idx) => (
                <QuestionTab
                  key={idx}
                  question={q}
                  answers={getEffectiveAnswers(idx)}
                  isActive={activeTab === idx}
                  onClick={() => setActiveTab(idx)}
                  index={idx}
                  total={questionCount}
                />
              ))}
              {/* Confirm tab */}
              <button
                type="button"
                onClick={() => setActiveTab(questionCount)}
                className={cn(
                  'shrink-0 rounded-md px-2 py-1 text-xs transition-colors',
                  activeTab === questionCount
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted/50 text-muted-foreground hover:bg-muted'
                )}
              >
                Confirm
              </button>
            </div>
          )}

          {/* Active question — interactive */}
          {activeTab < questionCount && questions[activeTab] && (
            <InteractiveQuestionContent
              question={questions[activeTab]}
              selectedLabels={selectedAnswers[activeTab] ?? []}
              customInput={customInputs[activeTab] ?? ''}
              customSelected={customSelected[activeTab] ?? false}
              onToggleOption={label => handleToggleOption(activeTab, label)}
              onCustomInputChange={value => handleCustomInputChange(activeTab, value)}
              onToggleCustom={() => handleToggleCustom(activeTab)}
              showHeader={false}
            />
          )}

          {/* Confirm tab — compact recap + submit */}
          {questionCount > 1 && activeTab === questionCount && (
            <div className="space-y-2">
              <div className="text-muted-foreground text-xs font-medium">Review your answers</div>
              {questions.map((q, idx) => {
                const allAnswers = getEffectiveAnswers(idx);
                const answered = allAnswers.length > 0;

                return (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => setActiveTab(idx)}
                    className={cn(
                      'w-full rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors',
                      answered
                        ? 'border-muted bg-muted/20 hover:bg-muted/40'
                        : 'border-yellow-500/40 bg-yellow-500/5 hover:bg-yellow-500/10'
                    )}
                  >
                    <div className="flex items-center gap-1.5">
                      {answered ? (
                        <Check className="h-3 w-3 shrink-0 text-green-500" />
                      ) : (
                        <AlertCircle className="h-3 w-3 shrink-0 text-yellow-500" />
                      )}
                      <span className="font-medium">{q.header || `Q${idx + 1}`}</span>
                    </div>
                    <div className="text-muted-foreground mt-0.5 truncate pl-[18px]">
                      {answered ? allAnswers.join(', ') : 'No answer yet'}
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {/* Submit error */}
          {submitError && <div className="mt-2 text-xs text-red-500">{submitError}</div>}

          {/* Action buttons — single question: always visible; multi-question: only on Confirm tab */}
          {(questionCount === 1 || activeTab === questionCount) && (
            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                onClick={handleSubmit}
                disabled={!hasAnyAnswer || isSubmitting || !requestId}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                  hasAnyAnswer && requestId && !isSubmitting
                    ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                    : 'bg-muted text-muted-foreground cursor-not-allowed'
                )}
              >
                {isSubmitting ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Send className="h-3 w-3" />
                )}
                Submit
              </button>
              <button
                type="button"
                onClick={handleDismiss}
                disabled={isSubmitting || !requestId}
                className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50"
              >
                <X className="h-3 w-3" />
                Dismiss
              </button>
              {!requestId && (
                <span className="text-muted-foreground text-[10px]">
                  Waiting for question ID...
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  // Non-running states: collapsible
  return (
    <div className="border-muted bg-muted/30 rounded-md border">
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        {getStatusIndicator(state.status)}
        <span className="min-w-0 flex-1 truncate text-sm">{headerText}</span>
        <ChevronDown
          className={cn(
            'text-muted-foreground h-4 w-4 shrink-0 transition-transform',
            isExpanded && 'rotate-180'
          )}
        />
      </button>

      {isExpanded && (
        <div className="border-muted border-t px-3 py-2">
          {questionCount > 1 && (
            <div className="mb-3 flex gap-1 overflow-x-auto pb-1">
              {questions.map((q, idx) => (
                <QuestionTab
                  key={idx}
                  question={q}
                  answers={completedAnswers[idx]}
                  isActive={activeTab === idx}
                  onClick={() => setActiveTab(idx)}
                  index={idx}
                  total={questionCount}
                />
              ))}
            </div>
          )}

          {questions[activeTab < questionCount ? activeTab : 0] && (
            <CompletedQuestionContent
              question={questions[activeTab < questionCount ? activeTab : 0]}
              answers={completedAnswers[activeTab < questionCount ? activeTab : 0]}
              showHeader={false}
            />
          )}

          {error && (
            <div className="mt-2">
              <div className="text-muted-foreground mb-1 text-xs">Error:</div>
              <pre className="bg-background overflow-auto rounded-md p-2 text-xs text-red-500">
                <code>{error}</code>
              </pre>
            </div>
          )}

          {state.status === 'pending' && (
            <div className="text-muted-foreground mt-2 text-xs italic">Preparing question...</div>
          )}
        </div>
      )}
    </div>
  );
}
