'use client';

import { useState, useCallback } from 'react';
import { useMutation } from '@tanstack/react-query';
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
import { useProject } from './ProjectSession';

type FeedbackDialogProps = {
  disabled?: boolean;
};

export function FeedbackDialog({ disabled }: FeedbackDialogProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [feedbackText, setFeedbackText] = useState('');
  const [showSuccess, setShowSuccess] = useState(false);

  const { manager, state } = useProject();
  const trpc = useTRPC();

  const {
    mutate,
    isPending,
    error,
    reset: resetMutation,
  } = useMutation(
    trpc.appBuilderFeedback.create.mutationOptions({
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
      if (!open) {
        // Reset state when dialog closes
        setFeedbackText('');
        setShowSuccess(false);
        resetMutation();
      }
    },
    [resetMutation]
  );

  const handleSubmit = useCallback(() => {
    if (!feedbackText.trim()) return;

    const recentMessages = state.messages.slice(-5).map(msg => ({
      role: msg.type,
      text: msg.text ?? msg.content ?? '',
      ts: msg.ts,
    }));

    mutate({
      project_id: manager.projectId,
      feedback_text: feedbackText.trim(),
      session_id: undefined, // session_id is on the project row, not directly on ProjectManager
      model: state.model || undefined,
      preview_status: state.previewStatus,
      is_streaming: state.isStreaming,
      message_count: state.messages.length,
      recent_messages: recentMessages,
    });
  }, [feedbackText, manager.projectId, state, mutate]);

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" disabled={disabled} title="Send feedback">
          <MessageSquareWarning className="mr-1 h-3 w-3" />
          Feedback
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Send Feedback</DialogTitle>
          <DialogDescription>
            Let us know how your App Builder experience is going. Your current session context will
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
