import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { type Href, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { QueryError } from '@/components/query-error';
import { Button } from '@/components/ui/button';
import { CircleCheck, Cloud } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useActiveSessions } from '@/lib/active-sessions-live-sync-mount';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { clearRunOnDestinationPreference } from '@/lib/hooks/use-persisted-run-on-destination';
import { captureSessionBaseline, hasNewSession } from '@/lib/tour/session-detection';

type TourCloudStepProps = {
  onCompletedChange: (completed: boolean) => void;
};

/**
 * The cloud path of the first-sign-in tour.
 *
 * The tour proves the session was created THROUGH its own action, so the step
 * captures the active-session ids present when the list first resolves and only
 * a cloud row that appears afterwards satisfies the check. A pre-existing cloud
 * session can never complete the path.
 */
export function TourCloudStep({ onCompletedChange }: Readonly<TourCloudStepProps>) {
  const { t } = useTranslation();
  const router = useRouter();
  const colors = useThemeColors();
  const { data, isError, isFetching, refetch } = useActiveSessions();
  const sessions = data?.sessions;

  // Baseline: the ids known the first time the live list resolves. Capturing
  // it on the first data (not on the empty mount) keeps a row that already
  // existed before the tour from counting as new.
  const [baselineIds, setBaselineIds] = useState<ReadonlySet<string> | null>(null);
  useEffect(() => {
    if (baselineIds === null && sessions !== undefined) {
      setBaselineIds(captureSessionBaseline(sessions));
    }
  }, [baselineIds, sessions]);

  const [hasStartedNewSession, setHasStartedNewSession] = useState(false);

  const detected =
    baselineIds !== null &&
    sessions !== undefined &&
    hasNewSession({ sessions, baselineIds, kind: 'cloud' });

  // Completion is sticky: once the check lands, a later poll failure must not
  // take it back and re-disable the tour's Done control.
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

  const handleStart = useCallback(() => {
    // The tour's cloud form must open on the Cloud Agent target: clear any
    // computer chosen earlier so it cannot leak into the run-on selector.
    clearRunOnDestinationPreference();
    setHasStartedNewSession(true);
    router.push('/(app)/agent-chat/new' as Href);
  }, [router]);

  // A live-service refusal (a non-retryable create failure, e.g. missing
  // credits) is owned by the form. The step only ever sees no new session, so
  // it stays waiting and never reports completion.
  if (isError && !completed) {
    return (
      <QueryError
        message={t('tour.networkError')}
        onRetry={() => {
          void refetch();
        }}
        isRetrying={isFetching}
      />
    );
  }

  let outcome: ReactNode = null;
  if (completed) {
    outcome = (
      <View className="flex-row items-center gap-2">
        <CircleCheck size={18} color={colors.good} />
        <Text className="text-sm font-semibold">{t('tour.cloudCheck')}</Text>
      </View>
    );
  } else if (hasStartedNewSession) {
    outcome = (
      <View className="items-center gap-2">
        <Text variant="muted">{t('tour.cloudWaiting')}</Text>
        <View className="h-5 flex-row items-center gap-2">
          <Skeleton className="h-[18px] w-[18px] rounded-full" />
          <Skeleton className="h-4 w-52" />
        </View>
      </View>
    );
  } else {
    outcome = (
      <Button size="lg" className="w-full" onPress={handleStart}>
        <Text className="text-base">{t('tour.cloudNewSession')}</Text>
      </Button>
    );
  }

  return (
    <View className="flex-1 items-center justify-center gap-6 px-6">
      <View className="h-20 w-20 items-center justify-center rounded-3xl border border-border bg-card">
        <Cloud size={36} color={colors.foreground} />
      </View>

      <View className="items-center gap-1">
        <Text variant="h3" className="text-center">
          {t('tour.cloudTitle')}
        </Text>
        <Text variant="muted" className="text-center text-base">
          {t('tour.cloudBody')}
        </Text>
      </View>

      {
        // One fixed-height slot: the CTA, the waiting skeleton and the check
        // all render into the same reserved space, so the loading -> check
        // swap never moves the surrounding layout.
      }
      <View className="h-16 w-full items-center justify-center">{outcome}</View>
    </View>
  );
}
