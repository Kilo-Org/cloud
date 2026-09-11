import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { QueryError } from '@/components/query-error';
import { Button } from '@/components/ui/button';
import { Check, CircleCheck, Server } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useActiveSessions } from '@/lib/active-sessions-live-sync-mount';
import { useRemoteInstanceSpawn } from '@/lib/hooks/use-remote-instance-spawn';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { dedupeInstanceLabels } from '@/lib/instance-picker-rows';
import { captureSessionBaseline, hasNewSession } from '@/lib/tour/session-detection';
import { useTRPC } from '@/lib/trpc';
import { cn } from '@/lib/utils';

const POLL_INTERVAL_MS = 10_000;
const SKELETON_ROW_COUNT = 3;

type TourRemoteStepProps = {
  onCompletedChange: (completed: boolean) => void;
};

/**
 * The computer / `kilo remote` path of the first-sign-in tour.
 *
 * The step discovers connected computers from the same `listInstances` source
 * the instance picker reads, and the check is gated on a REAL remote session:
 * it captures the active-session ids present when the live list first resolves
 * and only a remote row that appears afterwards, on the selected computer's
 * connection, satisfies it. A connected computer with no session never
 * completes the path.
 */
export function TourRemoteStep({ onCompletedChange }: Readonly<TourRemoteStepProps>) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const trpc = useTRPC();

  // Same source and error-vs-empty split as the instance picker. The query is
  // owned here so the tour self-populates as a CLI connects.
  const {
    data: instancesData,
    isPending: isLoadingInstances,
    isError: isInstancesError,
    isRefetching,
    refetch: refetchInstances,
  } = useQuery({
    ...trpc.activeSessions.listInstances.queryOptions(undefined, {
      refetchOnWindowFocus: true,
      refetchInterval: POLL_INTERVAL_MS,
      refetchIntervalInBackground: false,
    }),
    // A network failure must surface the retry CTA rather than a stale
    // "successfully empty" snapshot.
    retry: 1,
  });

  const computers = useMemo(
    () =>
      dedupeInstanceLabels((instancesData?.instances ?? []).filter(row => row.kind === 'remote')),
    [instancesData]
  );

  // The step presents one "the computer" at a time; the first discovered
  // connection is the default and tapping another row switches the target.
  const [preferredConnectionId, setPreferredConnectionId] = useState<string | null>(null);
  const selected =
    computers.find(computer => computer.connectionId === preferredConnectionId) ??
    computers[0] ??
    null;

  const { status: spawnStatus, spawn } = useRemoteInstanceSpawn();
  const [hasStarted, setHasStarted] = useState(false);

  const handleStart = useCallback(() => {
    if (selected === null) {
      return;
    }
    setHasStarted(true);
    void spawn(selected.connectionId);
  }, [selected, spawn]);

  // Baseline: the ids known the first time the live list resolves. Capturing
  // it on the first data (not on the empty mount) keeps a row that already
  // existed before the tour from counting as new.
  const { data: sessionsData } = useActiveSessions();
  const sessions = sessionsData?.sessions;
  const [baselineIds, setBaselineIds] = useState<ReadonlySet<string> | null>(null);
  useEffect(() => {
    if (baselineIds === null && sessions !== undefined) {
      setBaselineIds(captureSessionBaseline(sessions));
    }
  }, [baselineIds, sessions]);

  const detected =
    baselineIds !== null &&
    sessions !== undefined &&
    selected !== null &&
    hasNewSession({ sessions, baselineIds, kind: 'remote', connectionId: selected.connectionId });

  // Completion is sticky: once the check lands, a later poll failure or a
  // disconnected computer must not take it back and re-disable the tour's Done
  // control.
  const [completed, setCompleted] = useState(false);
  useEffect(() => {
    if (detected) {
      setCompleted(true);
    }
  }, [detected]);

  // Report only on a real change so a re-render never re-notifies the shell.
  const reportedRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (reportedRef.current !== completed) {
      reportedRef.current = completed;
      onCompletedChange(completed);
    }
  }, [completed, onCompletedChange]);

  // Retryable list failure: a real network error, distinct from the successful
  // zero-computer response below. The check and Start are absent.
  if (isInstancesError && !completed) {
    return (
      <QueryError
        message={t('tour.networkError')}
        onRetry={() => {
          void refetchInstances();
        }}
        isRetrying={isRefetching}
      />
    );
  }

  let content: ReactNode = null;
  if (completed) {
    content = (
      <View className="flex-row items-center justify-center gap-2">
        <CircleCheck size={18} color={colors.good} />
        <Text className="text-sm font-semibold">{t('tour.remoteCheck')}</Text>
      </View>
    );
  } else if (isLoadingInstances) {
    // Content-shaped skeleton rows sized like the discovered-computer list, so
    // resolving the query does not move the surrounding layout.
    content = (
      <View className="w-full gap-3">
        {Array.from({ length: SKELETON_ROW_COUNT }, (_, index) => (
          <View key={index} className="rounded-xl border border-border bg-card px-4 py-3">
            <Skeleton className="h-5 w-2/3 rounded-md" />
            <Skeleton className="mt-2 h-4 w-1/3 rounded-md" />
          </View>
        ))}
      </View>
    );
  } else if (computers.length === 0) {
    // Discovered nothing: a successful empty response, not an error. No Start,
    // no check — just the CLI hint and a refetch.
    content = (
      <View className="items-center gap-4">
        <View className="items-center gap-1">
          <Text variant="large" className="text-center">
            {t('tour.remoteEmptyTitle')}
          </Text>
          <Text variant="muted" className="text-center">
            {t('tour.remoteEmptyBody')}
          </Text>
        </View>
        <Text variant="mono" className="text-center">
          {t('tour.remoteRunHint')}
        </Text>
        <Button
          variant="outline"
          onPress={() => {
            void refetchInstances();
          }}
          loading={isRefetching}
        >
          <Text>{t('tour.checkAgain')}</Text>
        </Button>
      </View>
    );
  } else {
    const spawnRetryable = spawnStatus.status === 'retryable';
    const spawnNonRetryable = spawnStatus.status === 'nonRetryable';
    const isSpawning = spawnStatus.status === 'inFlight';

    let outcome: ReactNode = null;
    if (spawnRetryable) {
      // Retryable: the computer may have disconnected. The retry re-runs the
      // tour's own start action on the still-selected connection.
      outcome = (
        <View className="items-center gap-3">
          <Text variant="muted" className="text-center">
            {t('agents.remoteSpawnRetryable')}
          </Text>
          <Button variant="outline" onPress={handleStart}>
            <Text>{t('tour.retry')}</Text>
          </Button>
        </View>
      );
    } else if (spawnNonRetryable) {
      // Non-retryable: the CLI refused for a structural reason. Say so and keep
      // the start control as the re-entry point.
      outcome = (
        <View className="items-center gap-3">
          <Text variant="muted" className="text-center">
            {t('agents.remoteSpawnNonRetryable')}
          </Text>
          <Button size="lg" className="w-full" onPress={handleStart}>
            <Text className="text-base">{t('tour.remoteStart')}</Text>
          </Button>
        </View>
      );
    } else if (isSpawning || hasStarted) {
      // The session is being created (or was accepted) but the live list has
      // not seen it yet. Keep waiting; the check only lands on a real row.
      outcome = (
        <View className="items-center gap-2">
          <Text variant="muted">{t('tour.remoteWaiting')}</Text>
          <View className="h-5 flex-row items-center gap-2">
            <Skeleton className="h-[18px] w-[18px] rounded-full" />
            <Skeleton className="h-4 w-52" />
          </View>
        </View>
      );
    } else {
      outcome = (
        <Button size="lg" className="w-full" onPress={handleStart}>
          <Text className="text-base">{t('tour.remoteStart')}</Text>
        </Button>
      );
    }

    content = (
      <View className="w-full gap-4">
        <View className="w-full gap-2">
          {computers.map(computer => {
            const isSelected = computer.connectionId === selected?.connectionId;
            return (
              <Pressable
                key={computer.connectionId}
                testID={computer.testID}
                className={cn(
                  'flex-row items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 active:bg-secondary',
                  isSelected && 'border-primary'
                )}
                onPress={() => {
                  setPreferredConnectionId(computer.connectionId);
                }}
              >
                <Server size={18} color={colors.foreground} />
                <View className="flex-1">
                  <Text className="text-base text-foreground">{computer.name}</Text>
                  <Text variant="muted" className="text-sm">
                    {t('tour.remoteFound')}
                  </Text>
                </View>
                {isSelected ? <Check size={18} color={colors.primary} /> : null}
              </Pressable>
            );
          })}
        </View>
        {outcome}
      </View>
    );
  }

  return (
    <View className="flex-1 items-center justify-center gap-6 px-6">
      <View className="h-20 w-20 items-center justify-center rounded-3xl border border-border bg-card">
        <Server size={36} color={colors.foreground} />
      </View>

      <View className="items-center gap-1">
        <Text variant="h3" className="text-center">
          {t('tour.remoteTitle')}
        </Text>
        <Text variant="muted" className="text-center text-base">
          {t('tour.remoteBody')}
        </Text>
      </View>

      {
        // One reserved content slot: the skeleton, the empty card, the start
        // control and the check all render into the same space, so a
        // loading -> content swap never moves the header.
      }
      <View className="min-h-[240px] w-full items-stretch justify-center">{content}</View>
    </View>
  );
}
