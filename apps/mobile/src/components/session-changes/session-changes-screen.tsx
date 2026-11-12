/* eslint-disable max-lines -- one screen owns the capture, the file view, the review draft, and the send, and splitting them would thread a dozen props through three files. */
// A session's changes, read from the session's saved worktree capture: the
// changed-file list, one file's patch, and a review the reader builds by
// commenting on diff lines and sends to the agent as one message. The capture
// refreshes on demand, so the screen is no longer frozen at the moment it
// opened. A session with no Cloud Agent (a remote or finished CLI session) has
// no capture to refresh and keeps the read-only session diff.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Crypto from 'expo-crypto';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { EmptyState } from '@/components/empty-state';
import { normalizeAgentMode } from '@/components/agents/mode-normalize';
import { PrDiffFileListLoading } from '@/components/pr-review/diff/pr-diff-file-list-loading';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { SessionChangesCommentDialog } from '@/components/session-changes/session-changes-comment-dialog';
import { SessionChangesFileList } from '@/components/session-changes/session-changes-file-list';
import { SessionChangesFileView } from '@/components/session-changes/session-changes-file-view';
import { SessionChangesReviewSheet } from '@/components/session-changes/session-changes-review-sheet';
import { SessionDiffFileList } from '@/components/session-changes/session-diff-file-list';
import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/dialog';
import { IconButton } from '@/components/ui/icon-button';
import { FileDiff, RefreshCw } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { formatDate } from '@/lib/format';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { type PrReviewFile } from '@/lib/pr-review/diff/pr-review-file-types';
import { sessionDiffFileToPrReviewFile } from '@/lib/session-changes';
import {
  addSessionChangesComment,
  buildSessionChangesReviewPrompt,
  EMPTY_SESSION_CHANGES_DRAFT,
  getSessionChangesReviewBlock,
  removeSessionChangesComment,
  sessionChangesAnchorForLine,
  sessionChangesCaptureForFile,
  sessionChangesCommentsForFile,
  type SessionChangesDraft,
  type SessionChangesFile,
  sessionChangesFilePatch,
  type SessionChangesFilePatch,
  updateSessionChangesComment,
} from '@/lib/session-changes-review';
import { trpcClient, useTRPC } from '@/lib/trpc';
import { generateMessageId } from '@kilocode/cloud-agent-sdk/message-id';
import {
  type WorktreeReviewAnchor,
  type WorktreeReviewComment,
} from '@kilocode/app-shared/worktree-review';

type ReviewLine = { side: 'deletions' | 'additions'; lineNumber: number };

type CommentTarget = { anchor: WorktreeReviewAnchor; existingId: string | undefined };

type SessionChangesBodyProps = {
  sessionPending: boolean;
  sessionFailed: boolean;
  onRetrySession: () => void;
  readOnly: boolean;
  legacyFiles: PrReviewFile[] | null;
  legacyTooLarge: boolean;
  legacyPending: boolean;
  legacyFailed: boolean;
  onRetryLegacy: () => void;
  changesPending: boolean;
  changesFailed: boolean;
  onRetryChanges: () => void;
  files: SessionChangesFile[];
  truncated: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  openFile: SessionChangesFile | null;
  onOpenFile: (file: SessionChangesFile) => void;
  patchState: SessionChangesFilePatch | null;
  filePending: boolean;
  fileFailed: boolean;
  commentsForFile: WorktreeReviewComment[];
  commentsDisabledReason: string | undefined;
  onTapLine: (line: ReviewLine) => void;
  onRetryFile: () => void;
};

function ReadOnlyNotice() {
  const { t } = useTranslation();
  return (
    <View className="border-b border-hair-soft bg-secondary px-4 py-2">
      <Text variant="muted" className="text-xs" testID="session-changes-read-only">
        {t('agentChat.sessionChanges.readOnlyReason')}
      </Text>
    </View>
  );
}

function SessionChangesBody(props: Readonly<SessionChangesBodyProps>) {
  const { t } = useTranslation();
  if (props.sessionPending) {
    return <PrDiffFileListLoading />;
  }
  if (props.sessionFailed) {
    return <QueryError variant="server" onRetry={props.onRetrySession} />;
  }
  if (props.openFile !== null) {
    return (
      <SessionChangesFileView
        path={props.openFile.path}
        patchState={props.patchState}
        comments={props.commentsForFile}
        isPending={props.filePending}
        isError={props.fileFailed}
        refreshing={props.refreshing}
        onRefresh={props.onRefresh}
        onRetry={props.onRetryFile}
        onTapLine={props.onTapLine}
        commentsDisabledReason={props.commentsDisabledReason}
      />
    );
  }
  if (props.readOnly) {
    if (props.legacyPending) {
      return <PrDiffFileListLoading />;
    }
    if (props.legacyFailed) {
      return <QueryError variant="server" onRetry={props.onRetryLegacy} />;
    }
    if (props.legacyTooLarge) {
      return <EmptyState icon={FileDiff} title={t('agentChat.sessionChanges.tooLarge')} />;
    }
    if (props.legacyFiles !== null && props.legacyFiles.length > 0) {
      return (
        <View className="flex-1">
          <ReadOnlyNotice />
          <SessionDiffFileList files={props.legacyFiles} />
        </View>
      );
    }
    return (
      <View className="flex-1">
        <ReadOnlyNotice />
        <EmptyState icon={FileDiff} title={t('agentChat.sessionChanges.empty')} />
      </View>
    );
  }
  if (props.changesPending) {
    return <PrDiffFileListLoading />;
  }
  if (props.changesFailed) {
    return <QueryError variant="server" onRetry={props.onRetryChanges} />;
  }
  if (props.files.length === 0) {
    return <EmptyState icon={FileDiff} title={t('agentChat.sessionChanges.empty')} />;
  }
  return (
    <SessionChangesFileList
      files={props.files}
      truncated={props.truncated}
      refreshing={props.refreshing}
      onRefresh={props.onRefresh}
      onOpen={props.onOpenFile}
    />
  );
}

export function SessionChangesScreen({ sessionId }: Readonly<{ sessionId: string }>) {
  const { t } = useTranslation();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const insets = useSafeAreaInsets();
  const colors = useThemeColors();
  const { confirm, dialog } = useConfirmDialog();

  const sessionQuery = useQuery(trpc.cliSessionsV2.get.queryOptions({ session_id: sessionId }));
  const cloudAgentSessionId = sessionQuery.data?.cloud_agent_session_id ?? null;
  const organizationId = sessionQuery.data?.organization_id ?? undefined;
  const readOnly = sessionQuery.isSuccess && cloudAgentSessionId === null;

  const cloudSessionKey = [
    'session-changes',
    'cloud-session',
    cloudAgentSessionId,
    organizationId ?? null,
  ] as const;
  const cloudSessionQuery = useQuery({
    queryKey: cloudSessionKey,
    queryFn: async () => {
      if (cloudAgentSessionId === null) {
        throw new Error('No Cloud Agent session');
      }
      return await (organizationId
        ? trpcClient.organizations.cloudAgentNext.getSession.query({
            cloudAgentSessionId,
            organizationId,
          })
        : trpcClient.cloudAgentNext.getSession.query({ cloudAgentSessionId }));
    },
    enabled: cloudAgentSessionId !== null,
  });

  const changesKey = [
    'session-changes',
    'worktree-changes',
    cloudAgentSessionId,
    organizationId ?? null,
  ] as const;
  const changesQuery = useQuery({
    queryKey: changesKey,
    queryFn: async () => {
      if (cloudAgentSessionId === null) {
        throw new Error('No Cloud Agent session');
      }
      return await (organizationId
        ? trpcClient.organizations.cloudAgentNext.getWorktreeChanges.query({
            cloudAgentSessionId,
            organizationId,
          })
        : trpcClient.cloudAgentNext.getWorktreeChanges.query({ cloudAgentSessionId }));
    },
    enabled: cloudAgentSessionId !== null,
  });
  const snapshot = changesQuery.data?.snapshot ?? null;

  const legacyDiffQuery = useQuery({
    ...trpc.cliSessionsV2.getSessionDiff.queryOptions({ session_id: sessionId }),
    enabled: readOnly,
  });

  const [draft, setDraft] = useState<SessionChangesDraft>(EMPTY_SESSION_CHANGES_DRAFT);
  const [openFile, setOpenFile] = useState<SessionChangesFile | null>(null);
  const [commentTarget, setCommentTarget] = useState<CommentTarget | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [commentError, setCommentError] = useState<string | undefined>(undefined);
  const [sendError, setSendError] = useState<string | undefined>(undefined);
  const [sent, setSent] = useState(false);

  const refreshMutation = useMutation({
    mutationFn: async () => {
      if (cloudAgentSessionId === null) {
        throw new Error('No Cloud Agent session');
      }
      const result = organizationId
        ? await trpcClient.organizations.cloudAgentNext.refreshWorktreeChanges.mutate({
            cloudAgentSessionId,
            organizationId,
          })
        : await trpcClient.cloudAgentNext.refreshWorktreeChanges.mutate({
            cloudAgentSessionId,
          });
      if (result.snapshot) {
        queryClient.setQueryData(changesKey, { snapshot: result.snapshot });
      }
      return result.status;
    },
    onSuccess: status => {
      setRefreshFailed(status !== 'refreshed');
    },
    onError: () => {
      setRefreshFailed(true);
    },
  });
  const refreshing = refreshMutation.isPending;
  const refresh = useCallback(() => {
    if (cloudAgentSessionId === null) {
      return;
    }
    setRefreshFailed(false);
    refreshMutation.mutate();
  }, [cloudAgentSessionId, refreshMutation]);

  const fileRevision = useMemo(() => {
    if (openFile === null) {
      return undefined;
    }
    const listed = snapshot?.files.find(
      entry => entry.path === openFile.path && entry.scope === openFile.scope
    );
    return listed?.revision ?? snapshot?.revision;
  }, [openFile, snapshot]);

  const fileKey = [
    ...changesKey,
    'file',
    openFile?.path ?? '',
    openFile?.scope ?? '',
    fileRevision ?? 0,
  ] as const;
  const fileQuery = useQuery({
    queryKey: fileKey,
    queryFn: async () => {
      if (cloudAgentSessionId === null || openFile === null || fileRevision === undefined) {
        throw new Error('No worktree file to read');
      }
      const input = {
        cloudAgentSessionId,
        path: openFile.path,
        expectedRevision: fileRevision,
        ...(openFile.scope ? { scope: openFile.scope } : {}),
      };
      return await (organizationId
        ? trpcClient.organizations.cloudAgentNext.getWorktreeFile.query({
            ...input,
            organizationId,
          })
        : trpcClient.cloudAgentNext.getWorktreeFile.query(input));
    },
    enabled: cloudAgentSessionId !== null && openFile !== null && fileRevision !== undefined,
  });
  const patchState = sessionChangesFilePatch(fileQuery.data);

  const cloudSession = cloudSessionQuery.data;
  const capture = useMemo(() => {
    if (openFile === null || snapshot === null || cloudAgentSessionId === null || !cloudSession) {
      return null;
    }
    return sessionChangesCaptureForFile({
      userId: cloudSession.userId,
      organizationId,
      cloudAgentSessionId,
      worktreeId: cloudSession.worktreeId,
      snapshot,
      file: openFile,
    });
  }, [openFile, snapshot, cloudAgentSessionId, cloudSession, organizationId]);

  const commentsForFile = useMemo(
    () => (openFile === null ? [] : sessionChangesCommentsForFile(draft, openFile)),
    [draft, openFile]
  );

  const reviewBlock = getSessionChangesReviewBlock({
    cloudAgentSessionId,
    mode: cloudSession?.mode,
    model: cloudSession?.model,
  });

  const sendMutation = useMutation({
    mutationFn: async (input: {
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
        return await trpcClient.organizations.cloudAgentNext.sendMessage.mutate({
          ...body,
          organizationId,
        });
      }
      return await trpcClient.cloudAgentNext.sendMessage.mutate(body);
    },
  });

  const sendReview = () => {
    if (!cloudSession?.mode || !cloudSession.model) {
      return;
    }
    const built = buildSessionChangesReviewPrompt(draft);
    if (!built.ok) {
      setSendError(built.error);
      return;
    }
    setSendError(undefined);
    sendMutation.mutate(
      {
        prompt: built.prompt,
        mode: cloudSession.mode,
        model: cloudSession.model,
        variant: cloudSession.variant,
      },
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

  let commentsDisabledReason: string | undefined;
  if (cloudAgentSessionId === null) {
    commentsDisabledReason = t('agentChat.sessionChanges.readOnlyReason');
  } else if (capture === null) {
    commentsDisabledReason = t('agentChat.sessionChanges.noCaptureReason');
  }

  const asOf = useMemo(() => {
    if (snapshot !== null) {
      return t('agentChat.sessionChanges.asOf', {
        time: formatDate(new Date(snapshot.capturedAt), i18n.language, { timeStyle: 'short' }),
      });
    }
    if (legacyDiffQuery.isSuccess) {
      return t('agentChat.sessionChanges.asOf', {
        time: formatDate(new Date(legacyDiffQuery.dataUpdatedAt), i18n.language, {
          timeStyle: 'short',
        }),
      });
    }
    return undefined;
  }, [snapshot, legacyDiffQuery.isSuccess, legacyDiffQuery.dataUpdatedAt, t]);

  const legacyFiles = useMemo(
    () =>
      legacyDiffQuery.data?.kind === 'files'
        ? legacyDiffQuery.data.files.map(sessionDiffFileToPrReviewFile)
        : null,
    [legacyDiffQuery.data]
  );

  return (
    <View className="flex-1 bg-background" testID="session-changes-screen">
      <ScreenHeader
        title={openFile === null ? t('common.changes') : openFile.path}
        eyebrow={asOf}
        reserveEyebrow
        titleNumberOfLines={1}
        onBack={
          openFile === null
            ? undefined
            : () => {
                setOpenFile(null);
                setCommentTarget(null);
                setCommentError(undefined);
              }
        }
        headerRight={
          cloudAgentSessionId === null ? undefined : (
            <IconButton
              onPress={refresh}
              accessibilityLabel={t('common.refresh')}
              disabled={refreshing}
              testID="session-changes-refresh-button"
            >
              <RefreshCw size={18} color={colors.foreground} />
            </IconButton>
          )
        }
      />
      {refreshFailed ? (
        <Pressable
          onPress={refresh}
          accessibilityRole="button"
          accessibilityLabel={t('common.couldNotRefresh')}
          className="border-b border-hair-soft bg-warn-tile-bg px-4 py-2"
          testID="session-changes-refresh-error"
        >
          <Text className="text-xs text-warn">{t('common.couldNotRefresh')}</Text>
        </Pressable>
      ) : null}
      {sent ? (
        <View className="border-b border-hair-soft bg-secondary px-4 py-2">
          <Text variant="muted" className="text-xs" testID="session-changes-review-sent">
            {t('agentChat.sessionChanges.reviewSent')}
          </Text>
        </View>
      ) : null}
      {commentError === undefined ? null : (
        <View className="border-b border-hair-soft bg-danger-tile-bg px-4 py-2">
          <Text className="text-xs text-destructive">{commentError}</Text>
        </View>
      )}
      <View className="flex-1">
        <SessionChangesBody
          sessionPending={sessionQuery.isPending}
          sessionFailed={sessionQuery.isError}
          onRetrySession={() => {
            void sessionQuery.refetch();
          }}
          readOnly={readOnly}
          legacyFiles={legacyFiles}
          legacyTooLarge={legacyDiffQuery.data?.kind === 'too_large'}
          legacyPending={legacyDiffQuery.isPending}
          legacyFailed={legacyDiffQuery.isError}
          onRetryLegacy={() => {
            void legacyDiffQuery.refetch();
          }}
          changesPending={changesQuery.isPending}
          changesFailed={changesQuery.isError}
          onRetryChanges={() => {
            void changesQuery.refetch();
          }}
          files={snapshot?.files ?? []}
          truncated={snapshot?.truncated ?? false}
          refreshing={refreshing}
          onRefresh={refresh}
          openFile={openFile}
          onOpenFile={file => {
            setOpenFile(file);
            setCommentError(undefined);
          }}
          patchState={patchState}
          filePending={fileQuery.isPending}
          fileFailed={fileQuery.isError}
          commentsForFile={commentsForFile}
          commentsDisabledReason={commentsDisabledReason}
          onTapLine={openComment}
          onRetryFile={() => {
            refresh();
            void fileQuery.refetch();
          }}
        />
      </View>
      {draft.comments.length > 0 ? (
        <View
          className="absolute inset-x-0 bottom-0 flex-row justify-end border-t border-hair-soft bg-background px-4 py-2"
          style={{ paddingBottom: Math.max(insets.bottom, 8) }}
        >
          <Button
            onPress={() => {
              setReviewOpen(true);
            }}
            testID="session-changes-review-open"
          >
            <Text>
              {t('agentChat.sessionChanges.reviewTitle', { count: draft.comments.length })}
            </Text>
          </Button>
        </View>
      ) : null}
      <SessionChangesCommentDialog
        visible={commentTarget !== null}
        path={openFile?.path ?? ''}
        line={commentTarget?.anchor.range.startLine ?? 0}
        initialText={
          commentTarget?.existingId === undefined
            ? ''
            : (draft.comments.find(comment => comment.id === commentTarget.existingId)?.text ?? '')
        }
        onCancel={() => {
          setCommentTarget(null);
          setCommentError(undefined);
        }}
        onSubmit={submitComment}
      />
      <SessionChangesReviewSheet
        visible={reviewOpen}
        draft={draft}
        block={reviewBlock}
        error={sendError}
        sending={sendMutation.isPending}
        onClose={() => {
          setReviewOpen(false);
          setSendError(undefined);
        }}
        onSend={sendReview}
        onDiscard={discardReview}
        onRemoveComment={id => {
          setDraft(removeSessionChangesComment(draft, id));
        }}
      />
      {dialog}
    </View>
  );
}
