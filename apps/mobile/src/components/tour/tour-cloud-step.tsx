import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { type Href, useFocusEffect, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { CenteredState } from '@/components/centered-state';
import { QueryError } from '@/components/query-error';
import { TourStepHeader } from '@/components/tour/tour-step-header';
import { Button } from '@/components/ui/button';
import { CircleCheck, Cloud } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useActiveSessions } from '@/lib/active-sessions-live-sync-mount';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { PRESELECT_CLOUD_RUN_ON } from '@/lib/run-on-destination';
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

  // The heartbeat stream writes this same cache entry every few seconds, and a
  // cache write restarts the query's refetch interval (TanStack Query clears
  // and re-arms it on every query update), so the 30 s poll can be starved for
  // as long as heartbeats keep arriving. Without this, returning from the
  // session the person just created leaves the step waiting on a stale list.
  // Refresh on focus so the check lands the moment the tour is back on screen —
  // both when the step mounts and when the pushed session screen pops.
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;
  useFocusEffect(
    useCallback(() => {
      void refetchRef.current();
    }, [])
  );

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

  // While the session the person just created is still on its way, refresh the
  // live list on a short cadence. The heartbeat writes above starve the query's
  // own refetch interval, so this is what makes the check land promptly after
  // the create instead of waiting on a poll that never fires.
  useEffect(() => {
    if (!hasStartedNewSession || completed) {
      return undefined;
    }
    const id = setInterval(() => {
      void refetchRef.current();
    }, 5000);
    return () => {
      clearInterval(id);
    };
  }, [hasStartedNewSession, completed]);

  // Report only on a real change so a re-render never re-notifies the shell.
  const reportedRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (reportedRef.current !== completed) {
      reportedRef.current = completed;
      onCompletedChange(completed);
    }
  }, [completed, onCompletedChange]);

  const handleStart = useCallback(() => {
    // The tour's cloud form must open on the Cloud Agent target, but the
    // person's stored run-on destination must survive the tour: pass a
    // transient route param the form honors for this entry only, instead of
    // clearing the preference.
    setHasStartedNewSession(true);
    router.push(`/(app)/agent-chat/new?preselectRunOn=${PRESELECT_CLOUD_RUN_ON}` as Href);
  }, [router]);

  let outcome: ReactNode = null;
  if (isError && !completed) {
    // Retryable live-list failure: keep the step chrome (illustration, title,
    // body) mounted and render the error into the same reserved content slot
    // the CTA and the check use. A mid-tour failure therefore never blanks the
    // path the person chose, and Retry restores the step in place without
    // moving the surrounding layout.
    outcome = (
      <QueryError
        placement="top"
        className="pt-0"
        message={t('tour.networkError')}
        onRetry={() => {
          void refetch();
        }}
        isRetrying={isFetching}
      />
    );
  } else if (completed) {
    outcome = (
      <View className="flex-row items-center gap-2">
        <CircleCheck size={18} color={colors.good} />
        <Text className="text-sm font-semibold">{t('tour.cloudCheck')}</Text>
      </View>
    );
  } else if (hasStartedNewSession) {
    // A live-service refusal (a non-retryable create failure, e.g. missing
    // credits) is owned by the form. The step only ever sees no new session,
    // so it stays waiting and never reports completion.
    //
    // Opening the form latches this state, so returning from a form that never
    // created a row leaves the step here. Keep the CTA as the escape hatch:
    // without it the step is a dead end with Done disabled and no way to
    // create or retry (p7).
    outcome = (
      <View className="w-full items-center gap-4">
        <View className="items-center gap-2">
          <Text variant="muted">{t('tour.cloudWaiting')}</Text>
          <View className="h-5 flex-row items-center gap-2">
            <Skeleton className="h-[18px] w-[18px] rounded-full" />
            <Skeleton className="h-4 w-52" />
          </View>
        </View>
        <Button size="lg" className="w-full" onPress={handleStart}>
          <Text className="text-base">{t('tour.cloudNewSession')}</Text>
        </Button>
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
    <CenteredState>
      {/* Scrolls the whole step body: a large system font or a short screen can
          make the reserved content slot taller than the space between the
          header and the fixed action bar. Without a scroll container that
          overflow spilled over both. */}
      <View className="items-center gap-6 px-6">
        <TourStepHeader
          icon={<Cloud size={36} color={colors.foreground} />}
          title={t('tour.cloudTitle')}
          body={t('tour.cloudBody')}
        />

        {
          // One reserved slot: the CTA, the waiting skeleton, the check and the
          // retryable error all render into the same space, so no load, retry or
          // error swap moves the illustration and heading above.
        }
        <View className="min-h-[240px] w-full items-center justify-center">{outcome}</View>
      </View>
    </CenteredState>
  );
}
