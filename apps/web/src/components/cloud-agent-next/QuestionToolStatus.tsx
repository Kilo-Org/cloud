'use client';

import React from 'react';
import { useAtomValue } from 'jotai';
import { MessageCircleQuestion, Clock } from 'lucide-react';
import type { SessionManager } from '@kilocode/cloud-agent-sdk';
import { useOptionalManager } from './CloudAgentProvider';
import { ToolCardShell } from './ToolCardShell';
import type { ToolPart } from './types';
import type { QuestionInfo } from '@/types/opencode.gen';

export type ReadOnlyQuestionState = { isStreaming: boolean; hasActiveQuestion: boolean };

type QuestionInput = {
  questions: QuestionInfo[];
};

type QuestionMetadata = {
  answers?: string[][];
};

function questionsFrom(toolPart: ToolPart): QuestionInfo[] {
  return (toolPart.state.input as QuestionInput | undefined)?.questions ?? [];
}

function answersFrom(toolPart: ToolPart): string[][] {
  const { state } = toolPart;
  if (state.status === 'pending') return [];
  return (state.metadata as QuestionMetadata | undefined)?.answers ?? [];
}

function QuestionAnswerList({
  questions,
  answers,
}: {
  questions: QuestionInfo[];
  answers: string[][];
}) {
  if (questions.length === 0) return null;

  return (
    <div className="space-y-2">
      {questions.map((q, idx) => {
        const qAnswers = answers[idx] ?? [];
        return (
          <div key={idx} className="text-xs">
            <div className="text-muted-foreground font-medium">{q.question}</div>
            {qAnswers.length > 0 && (
              <div className="text-foreground mt-0.5">{qAnswers.join(', ')}</div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function QuestionSummaryCard({
  toolPart,
  subtitle,
  status,
}: {
  toolPart: ToolPart;
  subtitle: string;
  status: 'completed' | 'error';
}) {
  return (
    <ToolCardShell
      icon={MessageCircleQuestion}
      title="Questions"
      subtitle={subtitle}
      status={status}
    >
      <QuestionAnswerList questions={questionsFrom(toolPart)} answers={answersFrom(toolPart)} />
    </ToolCardShell>
  );
}

/**
 * Read-only question status for the message stream.
 *
 * While a question is pending/running, shows a subtle waiting indicator.
 * After completion, shows a summary of questions and their answers.
 * On error/dismissal, shows a dismissed label.
 *
 * This component has NO interactive elements — the interactive question UI
 * lives in the dock area (CloudChatPage).
 */
export function QuestionToolStatus({
  toolPart,
  presentation,
  readOnlyState,
}: {
  toolPart: ToolPart;
  presentation?: 'live' | 'historical';
  readOnlyState?: ReadOnlyQuestionState;
}) {
  const manager = useOptionalManager();
  if (!manager) {
    if (
      presentation === 'live' &&
      (toolPart.state.status === 'pending' || toolPart.state.status === 'running')
    )
      return readOnlyState?.isStreaming || readOnlyState?.hasActiveQuestion ? (
        <QuestionWaitingStatus />
      ) : (
        <QuestionInterruptedStatus toolPart={toolPart} />
      );
    return <QuestionToolStatusSnapshot toolPart={toolPart} />;
  }
  return <QuestionToolStatusLive toolPart={toolPart} manager={manager} />;
}

function QuestionToolStatusSnapshot({ toolPart }: { toolPart: ToolPart }) {
  const { status } = toolPart.state;
  if (status === 'error') {
    return (
      <QuestionSummaryCard toolPart={toolPart} subtitle="Questions dismissed" status="error" />
    );
  }
  if (status === 'pending' || status === 'running') {
    const asked = questionsFrom(toolPart).length;
    return (
      <QuestionSummaryCard
        toolPart={toolPart}
        subtitle={asked > 0 ? `${asked} asked` : 'Questions'}
        status="completed"
      />
    );
  }

  const answeredCount = answersFrom(toolPart).filter(a => a && a.length > 0).length;
  return (
    <QuestionSummaryCard
      toolPart={toolPart}
      subtitle={`${answeredCount} answered`}
      status="completed"
    />
  );
}

function QuestionToolStatusLive({
  toolPart,
  manager,
}: {
  toolPart: ToolPart;
  manager: SessionManager;
}) {
  const { status } = toolPart.state;
  const activeQuestion = useAtomValue(manager.atoms.activeQuestion);
  const isStreaming = useAtomValue(manager.atoms.isStreaming);
  if (status === 'pending' || status === 'running') {
    // Only treat as interrupted when the session is idle — during streaming the
    // question.asked event may not have propagated to activeQuestionAtom yet.
    if (!activeQuestion && !isStreaming) {
      return <QuestionInterruptedStatus toolPart={toolPart} />;
    }
    return <QuestionWaitingStatus />;
  }

  if (status === 'error') {
    return (
      <QuestionSummaryCard toolPart={toolPart} subtitle="Questions dismissed" status="error" />
    );
  }

  const answeredCount = answersFrom(toolPart).filter(a => a && a.length > 0).length;
  return (
    <QuestionSummaryCard
      toolPart={toolPart}
      subtitle={`${answeredCount} answered`}
      status="completed"
    />
  );
}

function QuestionWaitingStatus() {
  return (
    <div className="border-muted bg-muted/30 flex items-center gap-2 rounded-md border px-3 py-2">
      <Clock className="text-muted-foreground h-4 w-4 shrink-0 animate-pulse" />
      <span className="text-muted-foreground text-sm">Waiting for answer…</span>
    </div>
  );
}

function QuestionInterruptedStatus({ toolPart }: { toolPart: ToolPart }) {
  return (
    <ToolCardShell
      icon={MessageCircleQuestion}
      title="Questions"
      subtitle="Question interrupted"
      status="error"
    >
      <QuestionAnswerList questions={questionsFrom(toolPart)} answers={[]} />
    </ToolCardShell>
  );
}
