import { type ListRenderItem } from '@shopify/flash-list';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useWindowDimensions, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';

import { isInFlightReviewStatus } from '@kilocode/app-shared/code-review';
import { SessionMessageList } from '@/components/agents/session-message-list';
import { SessionSkeletonMessages } from '@/components/agents/session-detail-skeleton';
import {
  appendSpectatorRow,
  formatSpectatorTime,
  type SpectatorRow,
  spectatorRowsFromEntries,
  toSpectatorRow,
} from '@/components/code-reviewer/review-spectator-rows';
import {
  type Connection,
  createReviewSpectatorStream,
} from '@/components/code-reviewer/review-spectator-stream';
import { useRefetchSessionMessagesOnTerminal } from '@/components/code-reviewer/review-spectator-terminal-refetch';
import { QueryError } from '@/components/query-error';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useTRPC } from '@/lib/trpc';

const TERMINAL_REVIEW_STATUSES = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

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
    <View className="px-4 py-2">
      <Text variant="muted" className="text-xs">
        {message}
      </Text>
    </View>
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
  const { height: windowHeight } = useWindowDimensions();

  const streamInfo = useQuery({
    ...trpc.codeReviews.getReviewStreamInfo.queryOptions({ reviewId }),
    refetchInterval: query => {
      const data = query.state.data;
      if (!data?.success) {
        return 2000;
      }
      const isTerminal = TERMINAL_REVIEW_STATUSES.has(data.status);
      const isHistorical = data.agentVersion !== 'v2';
      // Poll only while an in-flight v2 review has not yet exposed its
      // cloud-agent session; everything else is stable.
      if (!isTerminal && !isHistorical && !data.cloudAgentSessionId) {
        return 2000;
      }
      return false;
    },
  });

  const [liveRows, setLiveRows] = useState<SpectatorRow[]>([]);
  const [liveError, setLiveError] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);

  const info = streamInfo.data?.success ? streamInfo.data : null;
  const effectiveStatus = info?.status ?? status;
  const isTerminal = TERMINAL_REVIEW_STATUSES.has(effectiveStatus);
  const isHistorical = info !== null && info.agentVersion !== 'v2';
  const shouldLoadHistory = info !== null && (isHistorical || isTerminal) && liveRows.length === 0;
  const cloudAgentSessionId = info?.cloudAgentSessionId ?? null;
  const isLiveCloud =
    info !== null && !isTerminal && info.agentVersion === 'v2' && cloudAgentSessionId !== null;
  const liveCloudId = isLiveCloud ? cloudAgentSessionId : null;

  const sessionMessages = useQuery({
    ...trpc.codeReviews.getSessionMessages.queryOptions({ reviewId }),
    enabled: Boolean(info) && shouldLoadHistory,
  });

  useRefetchSessionMessagesOnTerminal(isTerminal, shouldLoadHistory, sessionMessages.refetch);

  useEffect(() => {
    // Each effect run owns its dispose flag: a shared flag is reset at entry by
    // the next run, so a superseded start would see `false` after its own
    // cleanup ran and leave a second live socket. A run-local flag keeps the
    // stale start from calling `connect()` and makes it destroy its connection.
    let disposed = false;
    let connection: Connection | null = null;

    void (async () => {
      if (liveCloudId === null) {
        return;
      }
      setLiveError(false);
      try {
        const created = await createReviewSpectatorStream({
          cloudAgentSessionId: liveCloudId,
          organizationId: info?.organizationId,
          onEvent: event => {
            if (disposed) {
              return;
            }
            const row = toSpectatorRow(event, t);
            if (row !== null) {
              const keyedRow =
                row.key === undefined ? { ...row, key: `event-${event.eventId}` } : row;
              setLiveRows(prev => appendSpectatorRow(prev, keyedRow));
            }
          },
          onConnected: () => {
            if (!disposed) {
              setLiveError(false);
            }
          },
          onDisconnected: () => {
            if (!disposed) {
              setLiveError(true);
            }
          },
          onError: () => {
            if (!disposed) {
              setLiveError(true);
            }
          },
        });
        // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- the cleanup closure sets `disposed` after this await resolves
        if (disposed) {
          created.destroy();
          return;
        }
        connection = created;
        created.connect();
      } catch {
        // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- the cleanup closure sets `disposed` before this catch can run
        if (!disposed) {
          setLiveError(true);
        }
      }
    })();

    return () => {
      disposed = true;
      connection?.destroy();
    };
  }, [liveCloudId, info?.organizationId, retryNonce, t]);

  const historicalRows = useMemo(
    () =>
      sessionMessages.data?.success ? spectatorRowsFromEntries(sessionMessages.data.entries) : [],
    [sessionMessages.data]
  );

  const transcriptRows = shouldLoadHistory ? historicalRows : liveRows;
  const transcriptHeight = Math.min(360, Math.max(200, windowHeight * 0.35));
  const isInFlight = isInFlightReviewStatus(effectiveStatus);

  function renderSkeletonSlot() {
    return (
      <View style={{ height: transcriptHeight }}>
        <SessionSkeletonMessages />
      </View>
    );
  }

  function renderRowsSlot() {
    const isLive = isLiveCloud && !liveError;
    return (
      <View style={{ height: transcriptHeight }}>
        {isLive ? (
          <View className="px-4 pt-2">
            <Text variant="muted" className="text-xs">
              {t('codeReviewer.reviewDetail.transcriptLive')}
            </Text>
          </View>
        ) : null}
        {liveError && isLiveCloud ? (
          <View className="items-center px-4 pt-2">
            <Button
              variant="outline"
              size="sm"
              onPress={() => {
                setLiveError(false);
                setRetryNonce(count => count + 1);
              }}
            >
              <Text>{t('common.retry')}</Text>
            </Button>
          </View>
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
        />
      </View>
    );
  }

  function renderTranscriptSlot() {
    if (streamInfo.isLoading) {
      return renderSkeletonSlot();
    }
    if (streamInfo.isError || (streamInfo.data && !streamInfo.data.success)) {
      if (liveRows.length > 0) {
        return (
          <View>
            {renderRowsSlot()}
            <View className="items-center px-4 pt-2">
              <Button
                variant="outline"
                size="sm"
                onPress={() => {
                  void streamInfo.refetch();
                }}
              >
                <Text>{t('common.retry')}</Text>
              </Button>
            </View>
          </View>
        );
      }
      return (
        <QueryError
          variant="server"
          title={t('codeReviewer.reviewDetail.transcriptRetry')}
          placement="top"
          onRetry={() => {
            void streamInfo.refetch();
          }}
        />
      );
    }

    if (shouldLoadHistory) {
      if (sessionMessages.isLoading) {
        return renderSkeletonSlot();
      }
      if (sessionMessages.isError || !sessionMessages.data?.success) {
        return (
          <QueryError
            variant="server"
            title={t('codeReviewer.reviewDetail.transcriptRetry')}
            placement="top"
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
            isInFlight
              ? t('codeReviewer.reviewDetail.transcriptWaiting')
              : t('codeReviewer.reviewDetail.transcriptEmpty')
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
          placement="top"
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
    <View className="gap-2">
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
