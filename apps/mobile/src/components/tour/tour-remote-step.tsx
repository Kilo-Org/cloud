import { type ReactNode, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { CenteredState } from '@/components/centered-state';
import { QueryError } from '@/components/query-error';
import { TourStepHeader } from '@/components/tour/tour-step-header';
import { Button } from '@/components/ui/button';
import { ChevronRight, Server } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { dedupeInstanceLabels } from '@/lib/instance-picker-rows';
import { useTRPC } from '@/lib/trpc';

const POLL_INTERVAL_MS = 10_000;
const SKELETON_ROW_COUNT = 3;

type TourRemoteStepProps = {
  onChooseComputer: (connectionId: string) => void;
};

/**
 * The computer path of the first-sign-in tour.
 *
 * The step shows how to connect a computer and lists each one the
 * `listInstances` source (the same one the instance picker reads) discovers.
 * A tap hands the connection id to the shell, which opens the new-session page
 * with that computer preselected — the hand-off completes the tour. The step
 * never starts a session itself.
 */
export function TourRemoteStep({ onChooseComputer }: Readonly<TourRemoteStepProps>) {
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

  let content: ReactNode = null;
  if (isInstancesError) {
    // Retryable list failure: a real network error, distinct from the
    // successful zero-computer response below. Keep the step chrome mounted
    // and render the error into the reserved content slot, so a mid-tour
    // failure never blanks the path and Retry restores it in place.
    content = (
      <QueryError
        placement="top"
        className="pt-0"
        message={t('tour.networkError')}
        onRetry={() => {
          void refetchInstances();
        }}
        isRetrying={isRefetching}
      />
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
    // Discovered nothing: a successful empty response, not an error. Show the
    // start instructions and a refetch, never a dead end.
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
    // Detected: one hand-off row per computer, plus the start instructions so
    // the person can connect another machine while they decide.
    content = (
      <View className="w-full gap-4">
        <View className="w-full gap-2">
          {computers.map(computer => (
            <Pressable
              key={computer.connectionId}
              testID={computer.testID}
              accessibilityRole="button"
              accessibilityLabel={computer.name}
              className="flex-row items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 active:bg-secondary"
              onPress={() => {
                onChooseComputer(computer.connectionId);
              }}
            >
              <Server size={18} color={colors.foreground} />
              <View className="flex-1">
                <Text className="text-base text-foreground">{computer.name}</Text>
                <Text variant="muted" className="text-sm">
                  {t('tour.remoteFound')}
                </Text>
              </View>
              <ChevronRight size={18} color={colors.mutedForeground} />
            </Pressable>
          ))}
        </View>
        <Text variant="mono" className="text-center">
          {t('tour.remoteRunHint')}
        </Text>
      </View>
    );
  }

  return (
    <CenteredState>
      {/* Scrolls the whole step body: the discovered-computer list grows with
          every connected machine, and on a short screen or a large system font
          the fixed content slot plus that list exceeded the space between the
          header and the action bar. Without a scroll container the overflow
          covered the Skip bar. */}
      <View className="items-center gap-6 px-6">
        <TourStepHeader
          icon={<Server size={36} color={colors.foreground} />}
          title={t('tour.remoteTitle')}
          body={t('tour.remoteBody')}
        />

        {
          // One reserved content slot: the skeleton, the empty card, the error
          // and the computer list all render into the same space, so no load,
          // retry or state swap moves the header above it.
        }
        <View className="min-h-[240px] w-full items-stretch justify-center">{content}</View>
      </View>
    </CenteredState>
  );
}
