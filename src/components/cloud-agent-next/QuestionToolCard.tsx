'use client';

import { useState } from 'react';
import { ChevronDown, Loader2, XCircle, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
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
      {total > 1 ? `Q${index + 1}` : question.header || 'Question'}
      {hasAnswers && <Check className="ml-1 inline h-3 w-3" />}
    </button>
  );
}

function QuestionContent({ question, answers }: { question: QuestionInfo; answers?: string[] }) {
  const hasAnswers = answers && answers.length > 0;

  // Find custom answers (not matching any option label)
  const customAnswers = hasAnswers
    ? answers.filter(a => !question.options?.some(opt => opt.label === a))
    : [];

  return (
    <div className="space-y-2">
      {/* Question header and text */}
      {question.header && (
        <div className="text-muted-foreground text-xs font-medium">{question.header}</div>
      )}
      <div className="text-sm">{question.question}</div>

      {/* Options with selected highlighting */}
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

      {/* Show custom answers (not in options list) */}
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

      {/* Show info badges only when not answered */}
      {!hasAnswers && (
        <div className="flex gap-2 text-[10px]">
          {question.multiple && (
            <span className="bg-muted/50 text-muted-foreground rounded px-1.5 py-0.5">
              Multiple selection
            </span>
          )}
          {question.custom !== false && (
            <span className="bg-muted/50 text-muted-foreground rounded px-1.5 py-0.5">
              Custom allowed
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export function QuestionToolCard({ toolPart }: QuestionToolCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [activeTab, setActiveTab] = useState(0);

  const state = toolPart.state;
  const input = state.input as QuestionInput;
  const questions = input.questions || [];

  // Get answers from metadata (completed/running states have metadata)
  let answers: string[][] = [];
  if (state.status === 'completed' || state.status === 'running') {
    const metadata = state.metadata as QuestionMetadata | undefined;
    answers = metadata?.answers || [];
  }

  const error = state.status === 'error' ? state.error : undefined;
  const questionCount = questions.length;
  const answeredCount = answers.filter(a => a && a.length > 0).length;

  // Compact header text
  const headerText =
    questionCount === 1
      ? questions[0]?.header || 'Question'
      : `${questionCount} questions${answeredCount > 0 ? ` (${answeredCount} answered)` : ''}`;

  return (
    <div className="border-muted bg-muted/30 rounded-md border">
      {/* Collapsed header */}
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

      {/* Expanded content */}
      {isExpanded && (
        <div className="border-muted border-t px-3 py-2">
          {/* Tabs for multiple questions */}
          {questionCount > 1 && (
            <div className="mb-3 flex gap-1 overflow-x-auto pb-1">
              {questions.map((q, idx) => (
                <QuestionTab
                  key={idx}
                  question={q}
                  answers={answers[idx]}
                  isActive={activeTab === idx}
                  onClick={() => setActiveTab(idx)}
                  index={idx}
                  total={questionCount}
                />
              ))}
            </div>
          )}

          {/* Active question content */}
          {questions[activeTab] && (
            <QuestionContent question={questions[activeTab]} answers={answers[activeTab]} />
          )}

          {/* Error */}
          {error && (
            <div className="mt-2">
              <div className="text-muted-foreground mb-1 text-xs">Error:</div>
              <pre className="bg-background overflow-auto rounded-md p-2 text-xs text-red-500">
                <code>{error}</code>
              </pre>
            </div>
          )}

          {/* Running state */}
          {state.status === 'running' && (
            <div className="text-muted-foreground mt-2 text-xs italic">Waiting for answer...</div>
          )}

          {/* Pending state */}
          {state.status === 'pending' && (
            <div className="text-muted-foreground mt-2 text-xs italic">Preparing question...</div>
          )}
        </div>
      )}
    </div>
  );
}
