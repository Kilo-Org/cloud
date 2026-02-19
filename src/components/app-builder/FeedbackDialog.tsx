'use client';

import { useState, useCallback, useSyncExternalStore } from 'react';
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
import type { CloudMessage } from '@/components/cloud-agent/types';
import type { StoredMessage } from '@/components/cloud-agent-next/types';
import { isTextPart } from '@/components/cloud-agent-next/types';
import type { V1Session, V2Session } from './project-manager/types';

type FeedbackDialogProps = {
  disabled?: boolean;
  organizationId?: string;
};

export function FeedbackDialog({ disabled, organizationId }: FeedbackDialogProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [feedbackText, setFeedbackText] = useState('');
  const [showSuccess, setShowSuccess] = useState(false);

  const { manager, state } = useProject();
  const trpc = useTRPC();

  // Get the active session (last in state.sessions)
  const activeSession =
    state.sessions.length > 0 ? state.sessions[state.sessions.length - 1] : undefined;

  // Subscribe to the active session's state, split by type for correct typing
  const v1State = useSyncExternalStore(
    activeSession?.type === 'v1' ? activeSession.subscribe : noopSubscribe,
    activeSession?.type === 'v1' ? activeSession.getState : emptyV1State
  );
  const v2State = useSyncExternalStore(
    activeSession?.type === 'v2' ? activeSession.subscribe : noopSubscribe,
    activeSession?.type === 'v2' ? activeSession.getState : emptyV2State
  );

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
      // Reset state on both open and close so re-opening always starts fresh
      setFeedbackText('');
      setShowSuccess(false);
      resetMutation();
    },
    [resetMutation]
  );

  const handleSubmit = useCallback(() => {
    if (!feedbackText.trim()) return;

    let recentMessages: { role: string; text: string; ts: number }[];
    let messageCount: number;

    if (activeSession?.type === 'v1') {
      recentMessages = buildV1RecentMessages(v1State.messages);
      messageCount = v1State.messages.length;
    } else if (activeSession?.type === 'v2') {
      recentMessages = buildV2RecentMessages(v2State.messages);
      messageCount = v2State.messages.length;
    } else {
      recentMessages = [];
      messageCount = 0;
    }

    mutate({
      project_id: manager.projectId,
      organization_id: organizationId,
      feedback_text: feedbackText.trim(),
      model: state.model || undefined,
      preview_status: state.previewStatus,
      is_streaming: state.isStreaming,
      message_count: messageCount,
      recent_messages: recentMessages,
    });
  }, [
    feedbackText,
    manager.projectId,
    organizationId,
    state,
    activeSession?.type,
    v1State.messages,
    v2State.messages,
    mutate,
  ]);

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          disabled={disabled}
          title="Send feedback"
        >
          <MessageSquareWarning className="h-4 w-4" />
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

/**
 * Build recent_messages from V1 CloudMessage array.
 */
function buildV1RecentMessages(
  messages: CloudMessage[]
): { role: string; text: string; ts: number }[] {
  return messages.slice(-5).map(msg => ({
    role: msg.type,
    text: (msg.text ?? msg.content ?? '').slice(0, 10_000),
    ts: msg.ts,
  }));
}

/**
 * Build recent_messages from V2 StoredMessage array.
 * V2 messages store text in parts, not on info directly.
 */
function buildV2RecentMessages(
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

function noopSubscribe() {
  return () => {};
}

const EMPTY_V1: { messages: CloudMessage[]; isStreaming: boolean } = {
  messages: [],
  isStreaming: false,
};
function emptyV1State() {
  return EMPTY_V1;
}

const EMPTY_V2: { messages: StoredMessage[]; isStreaming: boolean } = {
  messages: [],
  isStreaming: false,
};
function emptyV2State() {
  return EMPTY_V2;
}
