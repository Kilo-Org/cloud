'use client';

import { useState, useCallback, useEffect, useId, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAtomValue } from 'jotai';
import { MessageSquareWarning, Loader2, Check, History } from 'lucide-react';
import { useTRPC } from '@/lib/trpc/utils';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { useManager } from './CloudAgentProvider';
import type { ResolvedSession } from '@kilocode/cloud-agent-sdk';
import type { StoredMessage } from './types';
import { isTextPart } from './types';
import { formatFeedbackTimestamp } from './feedback-history';

/** How many prior submissions the dialog shows. */
const FEEDBACK_HISTORY_LIMIT = 5;

type FeedbackDialogProps = {
  organizationId?: string;
  kiloSessionId?: string;
};

export function FeedbackDialog({ organizationId, kiloSessionId }: FeedbackDialogProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [feedbackText, setFeedbackText] = useState('');
  const [showSuccess, setShowSuccess] = useState(false);

  const manager = useManager();
  const messages = useAtomValue(manager.atoms.messagesList);
  const isStreaming = useAtomValue(manager.atoms.isStreaming);
  const currentSessionId = useAtomValue(manager.atoms.sessionId);
  const activeSessionType = useAtomValue(manager.atoms.activeSessionType);
  const sessionConfig = useAtomValue(manager.atoms.sessionConfig);

  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const historyHeadingId = useId();

  useEffect(() => {
    return () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    };
  }, []);

  // Prior submissions from this account, so the dialog can show that feedback
  // was already sent instead of starting blank every time. Only fetched while
  // the dialog is open.
  const historyQuery = useQuery({
    ...trpc.cloudAgentNextFeedback.list.queryOptions({ limit: FEEDBACK_HISTORY_LIMIT }),
    enabled: isOpen,
  });
  const history = historyQuery.data ?? [];
  const historyError = historyQuery.isError;
  const historyLoading = historyQuery.isPending;
  const showHistorySection = historyLoading || historyError || history.length > 0;

  const {
    mutate,
    isPending,
    error,
    reset: resetMutation,
  } = useMutation(
    trpc.cloudAgentNextFeedback.create.mutationOptions({
      onSuccess: () => {
        setShowSuccess(true);
        void queryClient.invalidateQueries(trpc.cloudAgentNextFeedback.list.queryFilter());
        closeTimerRef.current = setTimeout(() => {
          setIsOpen(false);
        }, 1200);
      },
    })
  );

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (closeTimerRef.current) {
        clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
      setIsOpen(open);
      setFeedbackText('');
      setShowSuccess(false);
      resetMutation();
    },
    [resetMutation]
  );

  const handleSubmit = useCallback(() => {
    if (!feedbackText.trim()) return;

    mutate({
      cloud_agent_session_id: currentSessionId ?? undefined,
      kilo_session_id: kiloSessionId ?? undefined,
      organization_id: organizationId ?? undefined,
      feedback_text: feedbackText.trim(),
      session_type: activeSessionType ?? undefined,
      model: feedbackModelForSession(activeSessionType, sessionConfig?.model),
      repository: sessionConfig?.repository || undefined,
      is_streaming: isStreaming,
      message_count: messages.length,
      recent_messages: buildRecentMessages(messages),
    });
  }, [
    feedbackText,
    currentSessionId,
    kiloSessionId,
    organizationId,
    activeSessionType,
    sessionConfig,
    isStreaming,
    messages,
    mutate,
  ]);

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground"
          title="Send feedback"
          aria-label="Send feedback"
        >
          <MessageSquareWarning className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Send Feedback</DialogTitle>
          <DialogDescription>
            Let us know how your Cloud Agent experience is going. Your current session context will
            be included automatically.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {showSuccess ? (
            <div className="flex items-center justify-center py-8" role="status" aria-live="polite">
              <Check className="h-6 w-6 text-green-500" />
              <span className="ml-2 text-sm text-green-500">Thank you for your feedback!</span>
            </div>
          ) : (
            <>
              <Textarea
                placeholder="What's on your mind?"
                value={feedbackText}
                onChange={e => setFeedbackText(e.target.value)}
                rows={4}
                disabled={isPending}
                autoFocus
              />

              {error && (
                <div className="rounded-md bg-red-500/10 p-3 text-sm text-red-400" role="alert">
                  Failed to send feedback. Please try again.
                </div>
              )}

              <div className="flex justify-end">
                <Button
                  onClick={handleSubmit}
                  disabled={isPending || !feedbackText.trim()}
                  size="sm"
                >
                  {isPending ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Sending...
                    </>
                  ) : (
                    'Send Feedback'
                  )}
                </Button>
              </div>

              {showHistorySection && (
                <div className="border-t pt-4">
                  <div className="text-muted-foreground mb-2 flex items-center gap-1.5">
                    <History className="h-3.5 w-3.5" aria-hidden="true" />
                    <h3 id={historyHeadingId} className="text-xs font-medium">
                      Your recent feedback
                    </h3>
                  </div>
                  {historyLoading ? (
                    <p className="text-muted-foreground text-xs">Loading recent feedback…</p>
                  ) : historyError ? (
                    <p className="text-muted-foreground text-xs" role="status">
                      Could not load recent feedback.
                    </p>
                  ) : history.length > 0 ? (
                    <ul
                      aria-labelledby={historyHeadingId}
                      className="max-h-48 space-y-2 overflow-y-auto pr-1"
                    >
                      {history.map(item => {
                        const timestamp = formatFeedbackTimestamp(item.created_at);
                        return (
                          <li key={item.id} className="bg-muted/50 rounded-md px-3 py-2">
                            <p className="text-foreground line-clamp-2 text-sm break-words">
                              {item.feedback_text}
                            </p>
                            {timestamp && (
                              <p className="text-muted-foreground mt-0.5 text-xs">{timestamp}</p>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}
                </div>
              )}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function feedbackModelForSession(
  sessionType: ResolvedSession['type'] | null,
  model: string | null | undefined
): string | undefined {
  return sessionType === 'cloud-agent' ? model || undefined : undefined;
}

function buildRecentMessages(
  messages: StoredMessage[]
): { role: string; text: string; ts: number }[] {
  return messages.slice(-5).map(msg => {
    const textContent = msg.parts
      .filter(isTextPart)
      .map(p => p.text)
      .join('')
      .slice(0, 10_000);

    return {
      role: msg.info.role,
      text: textContent,
      ts: msg.info.time.created,
    };
  });
}
