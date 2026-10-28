import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { EmptyState } from '@/components/empty-state';
import { PrDiffFileListLoading } from '@/components/pr-review/diff/pr-diff-file-list-loading';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { SessionDiffFileList } from '@/components/session-changes/session-diff-file-list';
import { FileDiff } from '@/components/ui/icons';
import { i18n } from '@/i18n';
import { formatDate } from '@/lib/format';
import { type PrReviewFile } from '@/lib/pr-review/diff/pr-review-file-types';
import { sessionDiffFileToPrReviewFile } from '@/lib/session-changes';
import { useTRPC } from '@/lib/trpc';

/**
 * A session's cumulative file diff, frozen at the moment the screen opens:
 * one fetch per open, never refetched while open, and dropped from the cache
 * on close (`gcTime: 0`) so the next open fetches again. The read cache never
 * persists diffs (`lib/persist/read-cache.ts`), so it stays in memory only.
 */
function useFrozenSessionDiff(sessionId: string) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.cliSessionsV2.getSessionDiff.queryOptions({ session_id: sessionId }),
    staleTime: Infinity,
    gcTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

export function SessionChangesScreen({ sessionId }: Readonly<{ sessionId: string }>) {
  const { t } = useTranslation();
  const query = useFrozenSessionDiff(sessionId);
  const files = useMemo(
    () =>
      query.data?.kind === 'files' ? query.data.files.map(sessionDiffFileToPrReviewFile) : null,
    [query.data]
  );

  const asOf = query.isSuccess
    ? t('agentChat.sessionChanges.asOf', {
        time: formatDate(new Date(query.dataUpdatedAt), i18n.language, { timeStyle: 'short' }),
      })
    : undefined;

  return (
    <View className="flex-1 bg-background" testID="session-changes-screen">
      <ScreenHeader
        title={t('common.changes')}
        eyebrow={asOf}
        reserveEyebrow
        titleNumberOfLines={1}
      />
      {query.isError ? (
        <QueryError
          variant={query.error.data?.code === 'NOT_FOUND' ? 'not-found' : 'server'}
          onRetry={
            query.error.data?.code === 'NOT_FOUND'
              ? undefined
              : () => {
                  void query.refetch();
                }
          }
          isRetrying={query.isFetching}
        />
      ) : (
        <SessionChangesBody isPending={query.isPending} files={files} />
      )}
    </View>
  );
}

function SessionChangesBody({
  isPending,
  files,
}: Readonly<{ isPending: boolean; files: PrReviewFile[] | null }>) {
  const { t } = useTranslation();
  if (isPending) {
    return <PrDiffFileListLoading />;
  }
  if (files === null) {
    return <EmptyState icon={FileDiff} title={t('agentChat.sessionChanges.tooLarge')} />;
  }
  if (files.length === 0) {
    return <EmptyState icon={FileDiff} title={t('agentChat.sessionChanges.empty')} />;
  }
  return <SessionDiffFileList files={files} />;
}
