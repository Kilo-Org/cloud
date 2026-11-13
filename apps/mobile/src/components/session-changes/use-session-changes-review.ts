// The review a reader builds on a session's diff: the draft comments, the line
// comment being written, and the one message the whole draft is sent as.

import { useMutation } from '@tanstack/react-query';
import * as Crypto from 'expo-crypto';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useConfirmDialog } from '@/components/ui/dialog';
import { normalizeAgentMode } from '@/components/agents/mode-normalize';
import {
  addSessionChangesComment,
  buildSessionChangesReviewPrompt,
  EMPTY_SESSION_CHANGES_DRAFT,
  getSessionChangesReviewBlock,
  removeSessionChangesComment,
  sessionChangesAnchorForLine,
  type SessionChangesDraft,
  type SessionChangesFile,
  type SessionChangesFilePatch,
  type SessionChangesReviewSend,
  sessionChangesReviewSend,
} from '@/lib/session-changes-review';
import { trpcClient } from '@/lib/trpc';
import { generateMessageId } from '@kilocode/cloud-agent-sdk/message-id';
import {
  type WorktreeReviewAnchor,
  type WorktreeReviewCapture,
  type WorktreeReviewComment,
} from '@kilocode/app-shared/worktree-review';

type ReviewLine = { side: 'deletions' | 'additions'; lineNumber: number };

type CommentTarget = { anchor: WorktreeReviewAnchor; existingId: string | undefined };

export function useSessionChangesReview({
  draft,
  setDraft,
  cloudAgentSessionId,
  organizationId,
  mode,
  model,
  variant,
  openFile,
  patchState,
  capture,
  commentsForFile,
  staleCommentIds,
}: {
  draft: SessionChangesDraft;
  setDraft: (draft: SessionChangesDraft) => void;
  cloudAgentSessionId: string | null;
  organizationId: string | undefined;
  mode: string | undefined;
  model: string | undefined;
  variant: string | undefined;
  openFile: SessionChangesFile | null;
  patchState: SessionChangesFilePatch | null;
  capture: WorktreeReviewCapture | null;
  commentsForFile: WorktreeReviewComment[];
  staleCommentIds: ReadonlySet<string>;
}) {
  const { t } = useTranslation();
  const { confirm, dialog } = useConfirmDialog();

  const [commentTarget, setCommentTarget] = useState<CommentTarget | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [commentError, setCommentError] = useState<string | undefined>(undefined);
  const [sendError, setSendError] = useState<string | undefined>(undefined);
  const [sent, setSent] = useState(false);
  const sendRef = useRef<SessionChangesReviewSend | null>(null);

  const sendMutation = useMutation({
    mutationFn: (input: {
      prompt: string;
      mode: string;
      model: string;
      variant: string | undefined;
    }) => {
      if (cloudAgentSessionId === null) {
        throw new Error('No Cloud Agent session');
      }
      // One id per draft content: a retry after an ambiguous failure reuses it
      // so the worker cannot start a second turn; a changed draft mints a new one.
      const send = sessionChangesReviewSend(sendRef.current, input.prompt, generateMessageId);
      sendRef.current = send;
      const body = {
        cloudAgentSessionId,
        messageId: send.messageId,
        payload: {
          type: 'prompt' as const,
          prompt: input.prompt,
          mode: normalizeAgentMode(input.mode),
          model: input.model,
          ...(input.variant ? { variant: input.variant } : {}),
        },
      };
      if (organizationId) {
        return trpcClient.organizations.cloudAgentNext.sendMessage.mutate({
          ...body,
          organizationId,
        });
      }
      return trpcClient.cloudAgentNext.sendMessage.mutate(body);
    },
  });

  const reviewBlock = getSessionChangesReviewBlock({
    cloudAgentSessionId,
    mode,
    model,
  });

  const sendReview = () => {
    if (!mode || !model) {
      return;
    }
    // The capture moved after these comments were written, so their quotes and
    // line numbers can no longer be presented to the agent as current.
    if (staleCommentIds.size > 0) {
      setSendError(t('agentChat.sessionChanges.staleFile'));
      return;
    }
    const built = buildSessionChangesReviewPrompt(draft);
    if (!built.ok) {
      setSendError(built.error);
      return;
    }
    setSendError(undefined);
    sendMutation.mutate(
      { prompt: built.prompt, mode, model, variant },
      {
        onSuccess: () => {
          sendRef.current = null;
          setDraft(EMPTY_SESSION_CHANGES_DRAFT);
          setReviewOpen(false);
          setSent(true);
        },
        onError: error => {
          setSendError(error.message);
        },
      }
    );
  };

  const discardReview = () => {
    confirm({
      title: t('agentChat.sessionChanges.discardReviewTitle'),
      message: t('agentChat.sessionChanges.discardReviewMessage'),
      confirmLabel: t('common.discard'),
      onConfirm: () => {
        setDraft(EMPTY_SESSION_CHANGES_DRAFT);
        setReviewOpen(false);
      },
    });
  };

  const openComment = (line: ReviewLine) => {
    if (openFile === null || capture === null || patchState?.status !== 'available') {
      return;
    }
    const anchored = sessionChangesAnchorForLine({
      capture,
      path: openFile.path,
      patch: patchState.patch,
      line,
    });
    if (!anchored.ok) {
      setCommentError(anchored.error);
      return;
    }
    setCommentError(undefined);
    const existing = commentsForFile.find(
      comment =>
        comment.anchor.range.side === anchored.anchor.range.side &&
        comment.anchor.range.startLine === anchored.anchor.range.startLine
    );
    setCommentTarget({ anchor: anchored.anchor, existingId: existing?.id });
  };

  const submitComment = (text: string) => {
    if (commentTarget === null) {
      return;
    }
    const trimmed = text.trim();
    // Editing re-anchors to the capture and line the reader is looking at now;
    // keeping the old anchor would pin the quote to a capture that has moved.
    const next =
      commentTarget.existingId === undefined
        ? addSessionChangesComment(draft, {
            id: Crypto.randomUUID(),
            anchor: commentTarget.anchor,
            text: trimmed,
          })
        : addSessionChangesComment(
            { comments: draft.comments.filter(comment => comment.id !== commentTarget.existingId) },
            { id: commentTarget.existingId, anchor: commentTarget.anchor, text: trimmed }
          );
    if (!next.ok) {
      setCommentError(next.error);
      return;
    }
    setDraft(next.draft);
    setCommentTarget(null);
    setCommentError(undefined);
    setSent(false);
  };

  const cancelComment = () => {
    setCommentTarget(null);
    setCommentError(undefined);
  };

  const initialCommentText =
    commentTarget?.existingId === undefined
      ? ''
      : (draft.comments.find(comment => comment.id === commentTarget.existingId)?.text ?? '');

  return {
    dialog,
    commentTarget,
    commentError,
    sendError,
    reviewOpen,
    sent,
    sending: sendMutation.isPending,
    reviewBlock,
    initialCommentText,
    setReviewOpen,
    setSendError,
    resetCommentError: () => {
      setCommentError(undefined);
    },
    openComment,
    submitComment,
    cancelComment,
    sendReview,
    discardReview,
    removeComment: (id: string) => {
      setDraft(removeSessionChangesComment(draft, id));
    },
  };
}
