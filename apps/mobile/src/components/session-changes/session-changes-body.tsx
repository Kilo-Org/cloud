// The content area of a session's changes screen: the opened file, or the
// changed-file list — the saved capture's list, or the read-only session diff
// for a session with no Cloud Agent.

import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { EmptyState } from '@/components/empty-state';
import { PrDiffFileListLoading } from '@/components/pr-review/diff/pr-diff-file-list-loading';
import { QueryError } from '@/components/query-error';
import { SessionChangesFileList } from '@/components/session-changes/session-changes-file-list';
import { SessionChangesFileView } from '@/components/session-changes/session-changes-file-view';
import { SessionDiffFileList } from '@/components/session-changes/session-diff-file-list';
import { FileDiff } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { type PrReviewFile } from '@/lib/pr-review/diff/pr-review-file-types';
import {
  type SessionChangesFile,
  type SessionChangesFilePatch,
} from '@/lib/session-changes-review';
import { type WorktreeReviewComment } from '@kilocode/app-shared/worktree-review';

type ReviewLine = { side: 'deletions' | 'additions'; lineNumber: number };

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

export function SessionChangesBody(props: Readonly<SessionChangesBodyProps>) {
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
