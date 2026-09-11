import { useQuery } from '@tanstack/react-query';
import { type Href, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BackHandler, Platform, Pressable, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';

import { TourChooseStep } from '@/components/first-run-tour/choose-step';
import { TourCliStep } from '@/components/first-run-tour/cli-step';
import { TourStepHero } from '@/components/first-run-tour/tour-step-hero';
import { useFirstRunTourBackGuard } from '@/components/first-run-tour/use-first-run-tour-back-guard';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Check, Cloud } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { buildAgentSessionListInput } from '@/lib/agent-session-input';
import { useLiveAgentSessions } from '@/lib/hooks/use-agent-sessions';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import {
  classifyTourFacts,
  type FirstRunTourStatus,
  markFirstRunTourStatus,
} from '@/lib/first-run-tour';
import { resolveInstancePickerViewState } from '@/lib/instance-picker-rows';
import { setFirstRunTourOpen } from '@/lib/notifications';
import { type InstancePickerInstance } from '@/lib/picker-bridge';
import { useTRPC } from '@/lib/trpc';

/**
 * Guided first-run tour: an opening fork (cloud session, or `kilo remote` on
 * your computer) whose chosen path ends on real evidence, not on clicks.
 * Every step keeps a Skip in the header; a leg only advances once the
 * classified facts (`@/lib/first-run-tour`) show the outcome actually
 * happened. The fork is not a linear slideshow: each path ends at its own
 * outcome and its own Done control, and the other path stays reachable by
 * replaying the tour from the Profile 'Tutorial' item.
 */

type TourStep = 'choose' | 'cloud' | 'cli';

const POLL_INTERVAL_MS = 10_000;

function stepTitle(step: TourStep, t: (key: string) => string): string {
  if (step === 'choose') {
    return t('firstRunTour.chooseTitle');
  }
  if (step === 'cloud') {
    return t('firstRunTour.cloudTitle');
  }
  return t('firstRunTour.cliTitle');
}

export function FirstRunTourFlow() {
  const router = useRouter();
  const colors = useThemeColors();
  const trpc = useTRPC();
  const { t } = useTranslation();
  const { userId } = useCurrentUserId();
  const [step, setStep] = useState<TourStep>('choose');

  // Same options as the instance picker so the caches are shared and the
  // 10 s poll keeps ticking while the tour waits for a computer.
  const instancesQuery = useQuery({
    ...trpc.activeSessions.listInstances.queryOptions(undefined, {
      refetchOnWindowFocus: true,
      refetchInterval: POLL_INTERVAL_MS,
      refetchIntervalInBackground: false,
    }),
    retry: 1,
  });
  const historyQuery = useQuery(
    // Personal scope: every stored-list caller passes the organization
    // context and personal is `null` (see read-cache.ts). An omitted
    // `organizationId` is a cross-organization read server-side, so the
    // tour must not build the input without it. The input stays the exact
    // canonical builder output (page size included): the encrypted read
    // cache persists and restores only that field-for-field shape, so a
    // bespoke smaller limit would fork the key off the shared snapshot.
    trpc.cliSessionsV2.list.queryOptions(buildAgentSessionListInput({ organizationId: null }), {
      refetchOnWindowFocus: true,
      // The cloud leg's success row can turn visible only AFTER the create's
      // own response settles (the ownership row reaches the list through the
      // ingest path — the same race the session-detail route tolerates with
      // its spawned-NOT_FOUND retry budget). The create-time invalidation and
      // the focus refetch below are each one-shot probes, so a probe landing
      // inside that window left the step in its initial copy forever and the
      // CTA never flipped to Done (e12, 2026-09-09). While the cloud step
      // is on screen and the evidence has not arrived, keep re-probing on the
      // tour's 10 s cadence (same contract as the instances poll); the
      // interval stops once the row is visible or the person leaves the step.
      refetchInterval: history =>
        step === 'cloud' &&
        !classifyTourFacts({
          historyRows: history.state.data?.cliSessions ?? [],
          liveSessions: [],
          instances: [],
        }).hasCloudSession
          ? POLL_INTERVAL_MS
          : false,
      refetchIntervalInBackground: false,
    })
  );
  const liveSessions = useLiveAgentSessions({ organizationId: null });

  const refetchInstances = instancesQuery.refetch;
  const refetchHistory = historyQuery.refetch;
  useFocusEffect(
    useCallback(() => {
      // Returning from the new-session screen (or from the background) must
      // re-probe the facts immediately; `refetchOnWindowFocus` only covers
      // OS-level foreground transitions (see instance-picker.tsx).
      void refetchInstances();
      void refetchHistory();
      // eslint-disable-next-line react-hooks/exhaustive-deps -- refetch identities are not memoized by react-query; including them would re-run this effect on every render.
    }, [])
  );

  // While this modal is on screen, a foreground push must not draw its
  // heads-up banner over the tour header — the cloud leg's session-ready push
  // lands exactly on the step title (see `setFirstRunTourOpen`). Focus-scoped:
  // a route pushed above the modal (new-session, session detail) restores
  // normal banner behavior.
  useFocusEffect(
    useCallback(() => {
      setFirstRunTourOpen(true);
      return () => {
        setFirstRunTourOpen(false);
      };
    }, [])
  );

  const instances: InstancePickerInstance[] = useMemo(
    () => instancesQuery.data?.instances ?? [],
    [instancesQuery.data]
  );
  const instancesViewState = resolveInstancePickerViewState({
    isLoading: instancesQuery.isPending,
    isError: instancesQuery.isError,
    instances,
  });

  const facts = useMemo(
    () =>
      classifyTourFacts({
        historyRows: historyQuery.data?.cliSessions ?? [],
        liveSessions: liveSessions.activeSessions,
        instances,
      }),
    [historyQuery.data, liveSessions.activeSessions, instances]
  );

  // Skip and Finish record the persisted decision, then dismiss immediately:
  // the mark is fired (it commits the SecureStore record and confirms the
  // landing) but the dismissal must not wait for it — the confirm-retry
  // budget can run seconds on a native storage failure, and an awaited mark
  // held the dismissed modal on screen for seconds under load (2026-09-07).
  // Re-showing is stopped by the
  // process-lifetime outcome latch the mark sets synchronously, so the gate
  // never re-arms while the write is in flight. Without a userId (briefly
  // during sign-in restore) there is no account to mark, so dismissal just
  // proceeds. Arming the guard last means a dismissal that already recorded
  // its decision only replays the navigation action when the removal is
  // intercepted below.
  //
  // Every Skip records, whenever it lands — including one seconds after the
  // first sign-in auto-open. The e2e login helper's automatic prompt
  // dismissal taps a visible 'Skip tour' like any other prompt; that is a
  // real dismissal and must persist (owner, 2026-09-08). First-sign-in
  // behavior is observed by the harness before that dismissal through the
  // login hook (`KILO_E2E_AFTER_LOGIN_FLOW`), not by product-side timing
  // grace that swallows skips.
  const skipNextGuardRef = useRef(false);
  const dismissWith = useCallback(
    (status: FirstRunTourStatus) => {
      if (userId) {
        void markFirstRunTourStatus(userId, status);
      }
      skipNextGuardRef.current = true;
      router.back();
    },
    [router, userId]
  );

  // Android hardware back, owned HERE rather than through the navigation
  // container. BackHandler subscriptions run last-registered-first, so this
  // focus-scoped listener is consulted before the container's and consumes
  // the press, dismissing the tour in-app exactly like the Skip button
  // (record 'skipped', then `router.back()` — which re-enters the removal
  // guard below as an armed replay). Focus-scoped so a route pushed above
  // the tour gets its own back behavior, and Android-only because iOS has
  // no hardware back. This listener can only ever fire because
  // `app.config.ts` ships `predictiveBackGestureEnabled: false`: with the
  // predictive-back opt-in, RN 0.86 registers its dispatcher back-callback
  // only when device SDK AND targetSdk are >= 36
  // (`AndroidVersion.isAtLeastTargetSdk36` in `ReactActivity.onCreate`), so
  // on Android 13-15 the press never reaches JS at all and the system
  // finishes the activity to the launcher (e4, 2026-09-08; verified on
  // device against the rebuilt binary: with the flag off the press
  // dismisses in-app and records).
  useFocusEffect(
    useCallback(() => {
      if (Platform.OS !== 'android') {
        return undefined;
      }
      const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
        dismissWith('skipped');
        return true;
      });
      return () => {
        subscription.remove();
      };
    }, [dismissWith])
  );

  // The modal can also be removed without the Skip/Finish buttons — a
  // deep-link RESET, or any removal that does reach react-navigation. Guard
  // every such removal: a back-type one records `skipped` (fired alongside
  // the action replay; the outcome latch stops the re-show, see the back
  // guard) so the tour never re-appears once the person leaves it; a
  // programmatic one (deep link) replays without recording, so the gate
  // re-opens the tour on the next home arrival.
  useFirstRunTourBackGuard({
    skipNextGuardRef,
    onUserDismissal: useCallback(async () => {
      if (userId) {
        await markFirstRunTourStatus(userId, 'skipped');
      }
    }, [userId]),
  });

  const skipButton = (
    <Pressable
      onPress={() => {
        dismissWith('skipped');
      }}
      hitSlop={12}
      accessibilityRole="button"
      className="active:opacity-70"
    >
      <Text className="text-base text-muted-foreground">{t('firstRunTour.skipTour')}</Text>
    </Pressable>
  );

  const openNewSession = useCallback(() => {
    // The new-session screen replaces itself with the created session
    // (`replaceWithAgentSession`), so back from the session lands here.
    router.push('/(app)/agent-chat/new' as Href);
  }, [router]);

  // The CLI leg's CTA promises a session on the user's computer, so the form
  // must not open on the Cloud Agent default: carry the connected instance's
  // `connectionId` (the same one the step's copy names) so the new-session
  // screen pre-selects it as the run-on target.
  const openCliNewSession = useCallback(() => {
    const { connectionId } = facts.connectedInstance ?? {};
    router.push(
      (connectionId
        ? `/(app)/agent-chat/new?connectionId=${connectionId}`
        : '/(app)/agent-chat/new') as Href
    );
  }, [router, facts.connectedInstance]);

  const headerTitle = stepTitle(step, t);

  // Back from a leg returns to the fork: the two paths are peers, so there is
  // no linear step behind either of them.
  const goBack = useCallback(() => {
    setStep('choose');
  }, []);

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title={headerTitle}
        modal
        showBackButton={step !== 'choose'}
        backIcon="back"
        onBack={step === 'choose' ? undefined : goBack}
        backFallback="/(app)/(tabs)/(0_home)"
        headerRight={skipButton}
      />
      <Animated.View layout={LinearTransition} className="flex-1">
        <Animated.View
          key={step}
          entering={FadeIn.duration(200)}
          exiting={FadeOut.duration(150)}
          className="flex-1 px-4 pt-4"
        >
          {step === 'choose' ? <TourChooseStep onSelect={setStep} /> : null}
          {step === 'cloud' ? (
            <View className="flex-1">
              <TourStepHero icon={Cloud}>
                <Text variant="muted" className="px-4 text-center leading-6">
                  {t('firstRunTour.cloudBody')}
                </Text>
              </TourStepHero>
              {/* Fixed-height status slot: the skeleton / ✓ / error swap must
                  never move the CTA below it. */}
              <View className="mt-6 min-h-9 flex-1 items-center">
                {historyQuery.isPending ? <Skeleton className="h-5 w-2/3 rounded-md" /> : null}
                {historyQuery.isError ? (
                  <View className="flex-row items-center gap-2">
                    {/* Identical copy already exists for the same failure
                        (session-list read error); point at that key. */}
                    <Text variant="muted">{t('share.retryableMessage')}</Text>
                    <Button
                      size="sm"
                      variant="ghost"
                      onPress={() => {
                        void historyQuery.refetch();
                      }}
                    >
                      <Text className="text-base text-primary">{t('common.retry')}</Text>
                    </Button>
                  </View>
                ) : null}
                {facts.hasCloudSession && !historyQuery.isPending && !historyQuery.isError ? (
                  <View className="flex-row items-center gap-1.5">
                    <Check size={18} color={colors.primary} />
                    <Text variant="muted">{t('firstRunTour.cloudSessionCreated')}</Text>
                  </View>
                ) : null}
              </View>
              <View className="mt-auto pb-6">
                {facts.hasCloudSession ? (
                  <Button
                    size="lg"
                  // The cloud path's own outcome reached: Done records the
                  // per-account decision on the spot and dismisses. The other
                  // path stays reachable by replaying the tour from Profile.
                    className="w-full"
                    onPress={() => {
                      dismissWith('done');
                    }}
                  >
                    <Text className="text-base">{t('common.done')}</Text>
                  </Button>
                ) : (
                  <Button size="lg" className="w-full" onPress={openNewSession}>
                    <Text className="text-base">{t('common.newSession')}</Text>
                  </Button>
                )}
              </View>
            </View>
          ) : null}
          {step === 'cli' ? (
            <TourCliStep
              facts={facts}
              viewState={instancesViewState}
              isInstancesRefetching={instancesQuery.isRefetching}
              onRefreshFacts={() => {
                // Refresh re-probes every fact the step renders: the
                // connected instance and any live `kilo remote` session.
                void instancesQuery.refetch();
                void liveSessions.refetch();
              }}
              openNewSession={openCliNewSession}
              onFinish={() => {
                dismissWith('done');
              }}
            />
          ) : null}
        </Animated.View>
      </Animated.View>
    </View>
  );
}
