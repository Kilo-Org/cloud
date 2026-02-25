'use client';

import { useState, useCallback } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useAtomValue } from 'jotai';
import { MessageSquareWarning, Loader2, Check } from 'lucide-react';
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
import {
  messagesListAtom,
  isStreamingAtom,
  currentSessionIdAtom,
  sessionConfigAtom,
  sessionOrganizationIdAtom,
} from './store/atoms';
import { currentDbSessionIdAtom } from './store/db-session-atoms';
import type { StoredMessage } from './types';
import { isTextPart } from './types';

export function FeedbackDialog() {
  const [isOpen, setIsOpen] = useState(false);
  const [feedbackText, setFeedbackText] = useState('');
  const [showSuccess, setShowSuccess] = useState(false);

  const messages = useAtomValue(messagesListAtom);
  const isStreaming = useAtomValue(isStreamingAtom);
  const currentSessionId = useAtomValue(currentSessionIdAtom);
  const currentDbSessionId = useAtomValue(currentDbSessionIdAtom);
  const sessionConfig = useAtomValue(sessionConfigAtom);
  const organizationId = useAtomValue(sessionOrganizationIdAtom);

  const trpc = useTRPC();

  const {
    mutate,
    isPending,
    error,
    reset: resetMutation,
  } = useMutation(
    trpc.cloudAgentNextFeedback.create.mutationOptions({
      onSuccess: () => {
        setShowSuccess(true);
        setTimeout(() => {
          setIsOpen(false);
        }, 1200);
      },
    })
  );

  const handleOpenChange = useCallback(
    (open: boolean) => {
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
      kilo_session_id: currentDbSessionId ?? undefined,
      organization_id: organizationId ?? undefined,
      feedback_text: feedbackText.trim(),
      model: sessionConfig?.model || undefined,
      repository: sessionConfig?.repository || undefined,
      is_streaming: isStreaming,
      message_count: messages.length,
      recent_messages: buildRecentMessages(messages),
    });
  }, [
    feedbackText,
    currentSessionId,
    currentDbSessionId,
    organizationId,
    sessionConfig,
    isStreaming,
    messages,
    mutate,
  ]);

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" className="h-7 w-7" title="Send feedback">
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
            <div className="flex items-center justify-center py-8">
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
                <div className="rounded-md bg-red-500/10 p-3 text-sm text-red-400">
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
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
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
