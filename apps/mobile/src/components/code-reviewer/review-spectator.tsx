import { type ListRenderItem } from '@shopify/flash-list';
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQuery } from '@tanstack/react-query';

import { SessionMessageList } from '@/components/agents/session-message-list';
import { SessionSkeletonMessages } from '@/components/agents/session-detail-skeleton';
import {
  resolveReviewSpectatorMode,
  retainPolledSpectatorRows,
  reviewSpectatorStreamInfoInterval,
} from '@/components/code-reviewer/review-spectator-behavior';
import { useReviewSpectatorLiveStream } from '@/components/code-reviewer/review-spectator-live';
import { CompactRetry } from '@/components/code-reviewer/review-spectator-retry';
import {
  formatSpectatorTime,
  type SpectatorRow,
  spectatorRowsFromEntries,
} from '@/components/code-reviewer/review-spectator-rows';
import { useRefetchSessionMessagesOnTerminal } from '@/components/code-reviewer/review-spectator-terminal-refetch';
import { CenteredState } from '@/components/centered-state';
import { QueryError } from '@/components/query-error';
import { Text } from '@/components/ui/text';
import { useTRPC } from '@/lib/trpc';

const renderSpectatorRow: ListRenderItem<SpectatorRow> = ({ item }) => (
  <View className="gap-1 px-4 py-1">
    <Text variant="muted" className="text-xs">
      {formatSpectatorTime(item.timestamp)}
    </Text>
    <Text className="text-xs">{item.message}</Text>
    {item.content ? (
      <Text variant="muted" className="text-xs">
        {item.content}
      </Text>
    ) : null}
  </View>
);

function SpectatorCopy({ message }: Readonly<{ message: string }>) {
  return (
    <CenteredState className="px-6">
      <Text variant="muted" className="text-center text-xs">
        {message}
      </Text>
    </CenteredState>
  );
}

// oxlint-disable-next-line no-empty-function -- SessionMessageList requires an older-messages handler; the spectator never paginates
function onLoadOlderMessagesNoop(): void {}

type ReviewSpectatorProps = {
  reviewId: string;
  status: string;
  prTitle: string;
  statusLabel: string;
};

export function ReviewSpectator({
  reviewId,
  status,
  prTitle,
  statusLabel,
}: Readonly<ReviewSpectatorProps>) {
  const { t } = useTranslation();
  const trpc = useTRPC();
  const insets = useSafeAreaInsets();

  const streamInfo = useQuery({
    ...trpc.codeReviews.getReviewStreamInfo.queryOptions({ reviewId }),
    refetchInterval: query => reviewSpectatorStreamInfoInterval(query.state.data),
  });

  const [liveRows, setLiveRows] = useState<SpectatorRow[]>([]);
  const [liveError, setLiveError] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);

  const info = streamInfo.data?.success ? streamInfo.data : null;
  const { isTerminal, shouldPollMessages, shouldLoadHistory, liveCloudId } =
    resolveReviewSpectatorMode(info, status, liveRows.length);
  const isLiveCloud = liveCloudId !== null;

  const sessionMessages = useQuery({
    ...trpc.codeReviews.getSessionMessages.queryOptions({ reviewId }),
    enabled: Boolean(info) && shouldLoadHistory,
    refetchInterval: shouldPollMessages ? 2000 : false,
  });

  useRefetchSessionMessagesOnTerminal(isTerminal, shouldLoadHistory, sessionMessages.refetch);
  useReviewSpectatorLiveStream({
    liveCloudId,
    organizationId: info?.organizationId,
    retryNonce,
    t,
    setLiveRows,
    setLiveError,
  });

  const historicalRows = useMemo(
    () =>
      sessionMessages.data?.success ? spectatorRowsFromEntries(sessionMessages.data.entries) : [],
    [sessionMessages.data]
  );
  const retainedHistoryRef = useRef<readonly SpectatorRow[]>([]);
  const displayHistory = retainPolledSpectatorRows(
    historicalRows,
    retainedHistoryRef.current,
    shouldPollMessages
  );
  if (historicalRows.length > 0) {
    retainedHistoryRef.current = historicalRows;
  }

  const transcriptRows =
    shouldLoadHistory || (info === null && liveRows.length === 0) ? displayHistory : liveRows;

  function renderRowsWithRetry(onRetry: () => void) {
    return (
      <View className="flex-1 pb-4">
        {renderRowsSlot()}
        <CompactRetry onPress={onRetry} />
      </View>
    );
  }

  function renderRowsSlot() {
    const isLive = isLiveCloud && !liveError;
    return (
      <View className="flex-1">
        {isLive ? (
          <View className="px-4 pt-2">
            <Text variant="muted" className="text-xs">
              {t('codeReviewer.reviewDetail.transcriptLive')}
            </Text>
          </View>
        ) : null}
        {liveError && isLiveCloud ? (
          <CompactRetry
            onPress={() => {
              setLiveError(false);
              setRetryNonce(count => count + 1);
            }}
          />
        ) : null}
        <SessionMessageList<SpectatorRow>
          sessionId={reviewId}
          items={transcriptRows}
          keyExtractor={row => row.key ?? row.timestamp}
          hasOlderMessages={false}
          isLoadingOlderMessages={false}
          olderMessagesError={null}
          olderMessagesOmittedItemCount={0}
          onLoadOlderMessages={onLoadOlderMessagesNoop}
          renderItem={renderSpectatorRow}
          contentBottomInset={Math.max(insets.bottom, 16)}
        />
      </View>
    );
  }

  function renderTranscriptSlot() {
    if (streamInfo.isLoading) {
      return <SessionSkeletonMessages />;
    }
    if (streamInfo.isError || (streamInfo.data && !streamInfo.data.success)) {
      if (transcriptRows.length > 0) {
        return renderRowsWithRetry(() => {
          void streamInfo.refetch();
        });
      }
      return (
        <QueryError
          variant="server"
          title={t('codeReviewer.reviewDetail.transcriptRetry')}
          onRetry={() => {
            void streamInfo.refetch();
          }}
        />
      );
    }

    if (shouldLoadHistory) {
      if (sessionMessages.isLoading) {
        return <SessionSkeletonMessages />;
      }
      if (sessionMessages.isError || !sessionMessages.data?.success) {
        if (historicalRows.length > 0) {
          return renderRowsWithRetry(() => {
            void sessionMessages.refetch();
          });
        }
        return (
          <QueryError
            variant="server"
            title={t('codeReviewer.reviewDetail.transcriptRetry')}
            onRetry={() => {
              void sessionMessages.refetch();
            }}
          />
        );
      }
      if (transcriptRows.length > 0) {
        return renderRowsSlot();
      }
      return (
        <SpectatorCopy
          message={
            isTerminal
              ? t('codeReviewer.reviewDetail.transcriptEmpty')
              : t('codeReviewer.reviewDetail.transcriptWaiting')
          }
        />
      );
    }

    // Not terminal v2: either a live stream or still waiting for a session.
    if (transcriptRows.length > 0) {
      return renderRowsSlot();
    }
    if (liveError) {
      return (
        <QueryError
          variant="server"
          title={t('codeReviewer.reviewDetail.transcriptRetry')}
          onRetry={() => {
            setLiveError(false);
            setRetryNonce(count => count + 1);
          }}
        />
      );
    }
    return <SpectatorCopy message={t('codeReviewer.reviewDetail.transcriptWaiting')} />;
  }

  return (
    <View className="flex-1 gap-2">
      <View className="flex-row items-center gap-2 px-4 pt-2">
        <Text className="flex-1 text-base font-medium" numberOfLines={1}>
          {prTitle}
        </Text>
        <Text variant="muted" className="text-xs">
          {statusLabel}
        </Text>
      </View>
      {renderTranscriptSlot()}
    </View>
  );
}
