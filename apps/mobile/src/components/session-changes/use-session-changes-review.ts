// The review a reader builds on a session's diff: the draft comments, the line
// comment being written, and the one message the whole draft is sent as.

import { useMutation } from '@tanstack/react-query';
import * as Crypto from 'expo-crypto';
import { useState } from 'react';
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
  updateSessionChangesComment,
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
}) {
  const { t } = useTranslation();
  const { confirm, dialog } = useConfirmDialog();

  const [commentTarget, setCommentTarget] = useState<CommentTarget | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [commentError, setCommentError] = useState<string | undefined>(undefined);
  const [sendError, setSendError] = useState<string | undefined>(undefined);
  const [sent, setSent] = useState(false);

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
      const body = {
        cloudAgentSessionId,
        messageId: generateMessageId(),
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
    const next =
      commentTarget.existingId === undefined
        ? addSessionChangesComment(draft, {
            id: Crypto.randomUUID(),
            anchor: commentTarget.anchor,
            text: trimmed,
          })
        : updateSessionChangesComment(draft, commentTarget.existingId, trimmed);
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
