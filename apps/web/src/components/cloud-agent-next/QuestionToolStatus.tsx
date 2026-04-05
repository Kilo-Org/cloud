'use client';

import { useAtomValue } from 'jotai';
import { MessageCircleQuestion, Clock } from 'lucide-react';
import { useManager } from './CloudAgentProvider';
import { ToolCardShell } from './ToolCardShell';
import type { ToolPart } from './types';
import type { QuestionInfo } from '@/types/opencode.gen';

type QuestionInput = {
  questions: QuestionInfo[];
};

type QuestionMetadata = {
  answers?: string[][];
};

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
export function QuestionToolStatus({ toolPart }: { toolPart: ToolPart }) {
  const { status } = toolPart.state;
  const manager = useManager();
  const activeQuestion = useAtomValue(manager.atoms.activeQuestion);
  const isStreaming = useAtomValue(manager.atoms.isStreaming);
  const questions: QuestionInfo[] =
    (toolPart.state.input as QuestionInput | undefined)?.questions ?? [];

  if (status === 'pending' || status === 'running') {
    // Only treat as interrupted when the session is idle — during streaming the
    // question.asked event may not have propagated to activeQuestionAtom yet.
    if (!activeQuestion && !isStreaming) {
      return (
        <ToolCardShell
          icon={MessageCircleQuestion}
          title="Questions"
          subtitle="Question interrupted"
          status="error"
        >
          {questions.length > 0 && (
            <div className="space-y-2">
              {questions.map((q, idx) => (
                <div key={idx} className="text-xs">
                  <div className="text-muted-foreground font-medium">{q.question}</div>
                </div>
              ))}
            </div>
          )}
        </ToolCardShell>
      );
    }
    return (
      <div className="border-muted bg-muted/30 flex items-center gap-2 rounded-md border px-3 py-2">
        <Clock className="text-muted-foreground h-4 w-4 shrink-0 animate-pulse" />
        <span className="text-muted-foreground text-sm">Waiting for answer…</span>
      </div>
    );
  }

  // Error / dismissed
  if (status === 'error') {
    return (
      <ToolCardShell
        icon={MessageCircleQuestion}
        title="Questions"
        subtitle="Questions dismissed"
        status="error"
      />
    );
  }

  // Completed — summary of questions with answers
  const answers: string[][] =
    (toolPart.state.metadata as QuestionMetadata | undefined)?.answers ?? [];
  const answeredCount = answers.filter(a => a && a.length > 0).length;

  return (
    <ToolCardShell
      icon={MessageCircleQuestion}
      title="Questions"
      subtitle={`${answeredCount} answered`}
      status="completed"
    >
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
    </ToolCardShell>
  );
}
