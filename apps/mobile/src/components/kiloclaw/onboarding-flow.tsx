/* eslint-disable max-lines -- wizard orchestrator owns state-machine wiring, analytics, and render branches */
import {
  type BotIdentity,
  execPresetToConfig,
  INITIAL_STATE,
  type ProvisionErrorCategory,
  reduce,
  shouldFireCompletion,
  shouldFireOnboardingEntered,
  shouldSaveBotIdentity,
  shouldSaveExecPreset,
} from '@/lib/onboarding';
import { useQueryClient } from '@tanstack/react-query';
import { type Href, useRouter } from 'expo-router';
import { X } from 'lucide-react-native';
import { type ReactNode, useCallback, useEffect, useReducer } from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';
import { toast } from 'sonner-native';

import { AccessRequiredScreen } from '@/components/kiloclaw/access-required-screen';
import { resolveAccessRequiredSubcase } from '@/components/kiloclaw/empty-state-content';
import { FlowBody } from '@/components/kiloclaw/onboarding/flow-body';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import {
  COMPLETION_REACHED_EVENT,
  ONBOARDING_ENTERED_EVENT,
  PROVISION_FAILED_EVENT,
  PROVISION_REQUESTED_EVENT,
  PROVISION_SUCCEEDED_EVENT,
  type ProvisionFailedCategory,
  WEATHER_LOCATION_SELECTED_EVENT,
  WEATHER_LOCATION_SKIPPED_EVENT,
} from '@/lib/analytics/onboarding-events';
import { trackEvent } from '@/lib/appsflyer';
import {
  useKiloClawGatewayReady,
  useKiloClawMobileOnboardingState,
  useKiloClawMutations,
  useKiloClawStatus,
} from '@/lib/hooks/use-kiloclaw-queries';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useTRPC } from '@/lib/trpc';

function categorizeProvisionError(error: {
  data?: { code?: string | null } | null;
}): ProvisionErrorCategory {
  const code = error.data?.code;
  if (code === 'CONFLICT' || code === 'FORBIDDEN') {
    return 'access_conflict';
  }
  return 'generic';
}

function uiCategoryToAnalyticsCategory(category: ProvisionErrorCategory): ProvisionFailedCategory {
  return category === 'access_conflict' ? 'access' : 'generic';
}

const GENERIC_PROVISION_ERROR_MESSAGE =
  "We couldn't set up your instance just now. Please try again.";

function resolveHeaderTitle(
  isIdentityStep: boolean,
  isLateStep: boolean,
  botName: string | undefined
): string {
  if (isIdentityStep) {
    return 'Give your bot an identity';
  }
  if (isLateStep) {
    return '';
  }
  return botName ?? '';
}

function resolveUserTimezone(): string | undefined {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

// eslint-disable-next-line max-lines-per-function -- owns the wizard state machine wiring
export function OnboardingFlow() {
  const router = useRouter();
  const colors = useThemeColors();
  const queryClient = useQueryClient();
  const trpc = useTRPC();
  const onboardingQuery = useKiloClawMobileOnboardingState();
  const mutations = useKiloClawMutations(null);

  const [state, dispatch] = useReducer(reduce, INITIAL_STATE);

  // Faster poll during onboarding (5s) so the "setting up" screen tracks the
  // gateway-ready poll cadence. Other screens keep the 10s default.
  const statusQuery = useKiloClawStatus(null, state.provisionStarted, 5000);
  const instanceStatus = statusQuery.data?.status ?? null;

  const gatewayReadyQuery = useKiloClawGatewayReady(null, state.provisionStarted);
  const gatewayReadyData = gatewayReadyQuery.data;

  // Translate external signals into reducer events.
  useEffect(() => {
    const data = onboardingQuery.data;
    if (!data) {
      return;
    }
    const kind = data.state;
    const eligible = kind === 'trial_eligible' || kind === 'has_access';
    // pending_settlement means the subscription is activating; the instance
    // may already exist, in which case we should redirect rather than block.
    const hasAccessWithInstance =
      (data.state === 'has_access' || data.state === 'pending_settlement') &&
      typeof data.instanceId === 'string';
    dispatch({
      type: 'onboarding-state-loaded',
      eligible,
      hasAccessWithInstance,
    });
  }, [onboardingQuery.data]);

  useEffect(() => {
    dispatch({ type: 'instance-status-changed', status: instanceStatus });
  }, [instanceStatus]);

  useEffect(() => {
    if (!gatewayReadyData) {
      return;
    }
    dispatch({
      type: 'gateway-readiness-changed',
      ready: gatewayReadyData.ready === true,
      settled: gatewayReadyData.settled === true,
      status: typeof gatewayReadyData.status === 'number' ? gatewayReadyData.status : null,
      nowMs: Date.now(),
    });
  }, [gatewayReadyData]);

  // has_access + existing instance: dismiss the modal so the user lands back
  // on whatever screen opened onboarding (KiloClaw tab empty state or Home).
  useEffect(() => {
    if (!state.provisionStarted && state.hasAccessWithInstance) {
      router.back();
    }
  }, [router, state.provisionStarted, state.hasAccessWithInstance]);

  // Selector-driven fire-once analytics.
  useEffect(() => {
    if (shouldFireOnboardingEntered(state)) {
      trackEvent(ONBOARDING_ENTERED_EVENT);
      dispatch({ type: 'onboarding-entered-emitted' });
    }
  }, [state]);

  useEffect(() => {
    if (shouldFireCompletion(state)) {
      trackEvent(COMPLETION_REACHED_EVENT);
      dispatch({ type: 'completion-reached-emitted' });
    }
  }, [state]);

  // Provision fires when the user submits the identity step (not on auto-start).
  // `userLocation` is passed here because state hasn't updated yet at call time.
  // When an instance already exists (retry after gateway/readiness stall),
  // skip re-provisioning: the DO row is live and the subsequent `channels-skipped`
  // step-save effects will re-apply any identity / exec-preset changes idempotently.
  const alreadyProvisioned = state.provisionSuccess && state.sandboxId !== null;
  const handleStart = useCallback(
    (userLocation: string | null) => {
      if (alreadyProvisioned) {
        dispatch({ type: 'start-requested' });
        return;
      }
      dispatch({ type: 'start-requested' });
      trackEvent(PROVISION_REQUESTED_EVENT);
      mutations.provision.mutate(
        {
          kilocodeDefaultModel: 'kilocode/kilo-auto/balanced',
          userTimezone: resolveUserTimezone(),
          userLocation: userLocation ?? undefined,
        },
        {
          onSuccess: result => {
            dispatch({ type: 'provision-succeeded', sandboxId: result.sandboxId });
            trackEvent(PROVISION_SUCCEEDED_EVENT);
          },
          onError: error => {
            const category = categorizeProvisionError(error);
            dispatch({ type: 'provision-failed', category });
            if (category === 'generic') {
              toast.error(GENERIC_PROVISION_ERROR_MESSAGE);
            }
            trackEvent(PROVISION_FAILED_EVENT, {
              category: uiCategoryToAnalyticsCategory(category),
            });
          },
        }
      );
    },
    [alreadyProvisioned, mutations.provision]
  );

  // Save the bot identity to the instance as soon as both the user has
  // committed to the identity step AND the provision mutation has resolved
  // (the instance row must exist before the router can look it up). The
  // backend persists the save durably even if the instance is still
  // `starting`, so we do not wait for the gateway to come up. The fire-once
  // guard lives in reducer state so `retry-requested` can re-open it.
  //
  // Failure semantics: the mutation hook retries transient 5xx with backoff
  // (`retryTransient` in use-kiloclaw-mutations) and surfaces permanent
  // failure as a toast via `onMutationError`. The fire-once flag stays set
  // on permanent failure — re-applying requires the user to re-submit the
  // identity step (which clears `botIdentitySaved`).
  //
  // Dep array is `[state, ...]` intentionally, matching the pattern used by
  // `shouldFireOnboardingEntered` / `shouldFireCompletion` above: the
  // selector guard keeps the effect idempotent and re-evaluation is cheap.
  const patchBotIdentityMutate = mutations.patchBotIdentity.mutate;
  useEffect(() => {
    if (!shouldSaveBotIdentity(state) || state.botIdentity === null) {
      return;
    }
    dispatch({ type: 'bot-identity-saved' });
    patchBotIdentityMutate(state.botIdentity);
  }, [state, patchBotIdentityMutate]);

  // Save the exec preset to the instance as soon as provision has resolved
  // and the user has committed to the identity step. Mobile has no wizard
  // step for the exec preset; the reducer holds the mobile-product default
  // (`never-ask`) and the selector gates on `execPreset !== 'always-ask'`
  // because `'always-ask'` matches the openclaw default and requires no
  // save. Failure semantics are the same as the bot-identity save above.
  const patchExecPresetMutate = mutations.patchExecPreset.mutate;
  useEffect(() => {
    if (!shouldSaveExecPreset(state) || state.execPreset === null) {
      return;
    }
    const config = execPresetToConfig(state.execPreset);
    dispatch({ type: 'exec-preset-saved' });
    patchExecPresetMutate(config);
  }, [state, patchExecPresetMutate]);

  // FlowBody callbacks map 1:1 to reducer events.
  const onIdentityContinue = useCallback(
    (identity: BotIdentity, weatherLocation: string | null) => {
      trackEvent(
        weatherLocation !== null ? WEATHER_LOCATION_SELECTED_EVENT : WEATHER_LOCATION_SKIPPED_EVENT
      );
      dispatch({ type: 'identity-submitted', identity, weatherLocation });
      handleStart(weatherLocation);
    },
    [handleStart]
  );

  const onNotificationsComplete = useCallback(() => {
    dispatch({ type: 'channels-skipped' });
  }, []);

  const onStepBack = useCallback(() => {
    dispatch({ type: 'step-back' });
  }, []);

  const onProvisioningComplete = useCallback(() => {
    dispatch({ type: 'provisioning-complete-acknowledged' });
  }, []);

  const onProvisioningRetry = useCallback(() => {
    dispatch({ type: 'retry-requested' });
  }, []);

  const onGraceElapsed = useCallback(() => {
    dispatch({ type: 'gateway-grace-elapsed' });
  }, []);

  const onDismiss = useCallback(() => {
    // When provision has started (or an instance exists), land on Home so the
    // user sees the live status card. Otherwise return to the entry screen.
    if (state.provisionStarted || state.sandboxId !== null) {
      // Home's focus-effect invalidation may miss this transition when a
      // modal is replaced with a tab route — tabs were mounted under the
      // modal the whole time, so no focus change fires. The provision
      // mutation's `onSuccess` already invalidates these keys, but with
      // `freezeOnBlur: true` Home's query observer may not be "active"
      // and the refetch would be deferred until the user interacts.
      // Force an immediate refetch here so the new card is visible as
      // soon as the server responds.
      void queryClient.refetchQueries({
        queryKey: trpc.kiloclaw.listAllInstances.queryKey(),
      });
      void queryClient.refetchQueries({
        queryKey: trpc.kiloclaw.getStatus.queryKey(),
      });
      router.replace('/(app)/(tabs)/(0_home)' as Href);
      return;
    }
    router.back();
  }, [
    queryClient,
    router,
    state.provisionStarted,
    state.sandboxId,
    trpc.kiloclaw.getStatus,
    trpc.kiloclaw.listAllInstances,
  ]);

  const onOpenInstance = useCallback(() => {
    // Dismiss the onboarding modal, then open the chat. `chat/[instance-id]`
    // is at the (app) layer, so it renders above the tab bar once the modal
    // closes.
    router.back();
    if (state.sandboxId) {
      router.push(`/(app)/chat/${state.sandboxId}` as Href);
    }
  }, [router, state.sandboxId]);

  const closeButton: ReactNode = (
    <Pressable
      onPress={onDismiss}
      hitSlop={12}
      accessibilityLabel="Close"
      accessibilityRole="button"
      className="active:opacity-70"
    >
      <X size={24} color={colors.foreground} />
    </Pressable>
  );

  if (onboardingQuery.isPending || !state.onboardingStateLoaded) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title="" modal showBackButton={false} headerRight={closeButton} />
        <Animated.View layout={LinearTransition} className="flex-1 px-4 pt-4">
          <Animated.View exiting={FadeOut.duration(150)} className="gap-3">
            <Skeleton className="h-48 w-full rounded-xl" />
          </Animated.View>
        </Animated.View>
      </View>
    );
  }

  if (onboardingQuery.isError) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title="" modal showBackButton={false} headerRight={closeButton} />
        <View className="flex-1 items-center justify-center px-4">
          <QueryError
            message="Could not load onboarding state"
            onRetry={() => {
              void onboardingQuery.refetch();
            }}
          />
        </View>
      </View>
    );
  }

  if (!state.eligible && !state.hasAccessWithInstance) {
    const subcase = onboardingQuery.data
      ? resolveAccessRequiredSubcase(onboardingQuery.data)
      : null;
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title="" modal showBackButton={false} headerRight={closeButton} />
        <Animated.View
          entering={FadeIn.duration(200)}
          className="flex-1 items-center justify-center"
        >
          {subcase ? (
            <AccessRequiredScreen subcase={subcase} />
          ) : (
            // pending_settlement without an instance — the subscription is still
            // activating server-side. `resolveAccessRequiredSubcase` returns null
            // because this is neither an access-required nor a remediation case.
            <Text variant="muted" className="px-6 text-center">
              Finishing setup — hang tight while we finalize your account.
            </Text>
          )}
        </Animated.View>
      </View>
    );
  }

  const isIdentityStep = state.step === 'identity';
  const isChannelsStep = state.step === 'channels';
  const onLateStep = state.step === 'provisioning' || state.step === 'done';
  const hasError = state.errorCategory !== null;
  const canStepBack = isChannelsStep && !hasError;
  const instanceReady =
    instanceStatus === 'running' &&
    gatewayReadyData?.ready === true &&
    gatewayReadyData.settled === true;

  // Identity step: dismiss is allowed (provision hasn't started yet).
  // Channels step: locked while provision runs — shows status indicator instead.
  // Everything else (provisioning, done, errors): close button.
  let headerRight: ReactNode = undefined;
  if (isIdentityStep) {
    headerRight = closeButton;
  } else if (isChannelsStep && !hasError) {
    headerRight = instanceReady ? (
      <View className="flex-row items-center gap-1.5">
        <View className="h-2 w-2 rounded-full bg-green-500" />
        <Text className="text-xs text-muted-foreground">Ready</Text>
      </View>
    ) : (
      <View className="flex-row items-center gap-1.5">
        <ActivityIndicator size="small" color={colors.mutedForeground} />
        <Text className="text-xs text-muted-foreground">Setting up…</Text>
      </View>
    );
  } else {
    headerRight = closeButton;
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title={resolveHeaderTitle(isIdentityStep, onLateStep, state.botIdentity?.botName)}
        modal
        showBackButton={canStepBack}
        backIcon="back"
        onBack={canStepBack ? onStepBack : undefined}
        headerRight={headerRight}
      />
      <Animated.View layout={LinearTransition} className="flex-1">
        <FlowBody
          state={state}
          onIdentityContinue={onIdentityContinue}
          onNotificationsComplete={onNotificationsComplete}
          onProvisioningComplete={onProvisioningComplete}
          onRetry={onProvisioningRetry}
          onGraceElapsed={onGraceElapsed}
          onOpenInstance={onOpenInstance}
        />
      </Animated.View>
    </View>
  );
}
