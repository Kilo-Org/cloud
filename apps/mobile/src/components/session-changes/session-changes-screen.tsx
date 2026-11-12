// A session's changes, read from the session's saved worktree capture: the
// changed-file list, one file's patch, and a review the reader builds by
// commenting on diff lines and sends to the agent as one message. The capture
// refreshes on demand, so the screen is no longer frozen at the moment it
// opened. A session with no Cloud Agent (a remote or finished CLI session) has
// no capture to refresh and keeps the read-only session diff.

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { SessionChangesBody } from '@/components/session-changes/session-changes-body';
import { SessionChangesCommentDialog } from '@/components/session-changes/session-changes-comment-dialog';
import { SessionChangesReviewSheet } from '@/components/session-changes/session-changes-review-sheet';
import { useSessionChangesData } from '@/components/session-changes/use-session-changes-data';
import { useSessionChangesFile } from '@/components/session-changes/use-session-changes-file';
import { useSessionChangesReview } from '@/components/session-changes/use-session-changes-review';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { RefreshCw } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { formatDate } from '@/lib/format';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import {
  EMPTY_SESSION_CHANGES_DRAFT,
  type SessionChangesDraft,
  type SessionChangesFile,
  sessionChangesStaleCommentIds,
} from '@/lib/session-changes-review';

export function SessionChangesScreen({ sessionId }: Readonly<{ sessionId: string }>) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const colors = useThemeColors();

  const data = useSessionChangesData(sessionId);
  const [openFile, setOpenFile] = useState<SessionChangesFile | null>(null);
  const [draft, setDraft] = useState<SessionChangesDraft>(EMPTY_SESSION_CHANGES_DRAFT);
  const file = useSessionChangesFile({
    openFile,
    snapshot: data.snapshot,
    changesKey: data.changesKey,
    cloudAgentSessionId: data.cloudAgentSessionId,
    organizationId: data.organizationId,
    userId: data.cloudSession?.userId,
    worktreeId: data.cloudSession?.worktreeId,
    draft,
  });
  const staleCommentIds = useMemo(
    () =>
      sessionChangesStaleCommentIds({
        draft,
        snapshot: data.snapshot,
        userId: data.cloudSession?.userId,
        organizationId: data.organizationId,
        cloudAgentSessionId: data.cloudAgentSessionId,
        worktreeId: data.cloudSession?.worktreeId,
      }),
    [
      draft,
      data.snapshot,
      data.cloudSession?.userId,
      data.cloudSession?.worktreeId,
      data.organizationId,
      data.cloudAgentSessionId,
    ]
  );
  const review = useSessionChangesReview({
    draft,
    setDraft,
    cloudAgentSessionId: data.cloudAgentSessionId,
    organizationId: data.organizationId,
    mode: data.cloudSession?.mode,
    model: data.cloudSession?.model,
    variant: data.cloudSession?.variant,
    openFile,
    patchState: file.patchState,
    capture: file.capture,
    commentsForFile: file.commentsForFile,
    staleCommentIds,
  });

  const {
    sessionQuery,
    cloudAgentSessionId,
    readOnly,
    changesQuery,
    snapshot,
    legacyDiffQuery,
    legacyFiles,
    refreshing,
    refresh,
    refreshFailed,
  } = data;
  const {
    dialog,
    commentTarget,
    commentError,
    sendError,
    reviewOpen,
    sent,
    sending,
    reviewBlock,
    initialCommentText,
    setReviewOpen,
    setSendError,
    resetCommentError,
    openComment,
    submitComment,
    cancelComment,
    sendReview,
    discardReview,
    removeComment,
  } = review;

  let commentsDisabledReason: string | undefined = undefined;
  if (cloudAgentSessionId === null) {
    commentsDisabledReason = t('agentChat.sessionChanges.readOnlyReason');
  } else if (file.capture === null) {
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
                cancelComment();
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
        {data.cloudSessionQuery.isError ? (
          <QueryError
            variant="server"
            onRetry={() => {
              void data.cloudSessionQuery.refetch();
            }}
          />
        ) : (
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
            onOpenFile={next => {
              setOpenFile(next);
              resetCommentError();
            }}
            patchState={file.patchState}
            filePending={file.fileQuery.isPending}
            fileFailed={file.fileQuery.isError}
            commentsForFile={file.commentsForFile}
            commentsDisabledReason={commentsDisabledReason}
            onTapLine={openComment}
            onRetryFile={() => {
              refresh();
              void file.fileQuery.refetch();
            }}
          />
        )}
      </View>
      {draft.comments.length > 0 ? (
        <View
          className="flex-row justify-end border-t border-hair-soft bg-background px-4 py-2"
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
      {commentTarget === null ? null : (
        <SessionChangesCommentDialog
          path={openFile?.path ?? ''}
          line={commentTarget.anchor.range.startLine}
          initialText={initialCommentText}
          editing={commentTarget.existingId !== undefined}
          onCancel={cancelComment}
          onSubmit={submitComment}
        />
      )}
      <SessionChangesReviewSheet
        visible={reviewOpen}
        draft={draft}
        staleCommentIds={staleCommentIds}
        block={reviewBlock}
        error={sendError}
        sending={sending}
        onClose={() => {
          setReviewOpen(false);
          setSendError(undefined);
        }}
        onSend={sendReview}
        onDiscard={discardReview}
        onRemoveComment={removeComment}
      />
      {dialog}
    </View>
  );
}
