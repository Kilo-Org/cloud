'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useFeatureFlagVariantKey, usePostHog } from 'posthog-js/react';
import { toast } from 'sonner';
import { Loader2, TriangleAlert, X } from 'lucide-react';
import { KILO_AUTO_BALANCED_MODEL } from '@/lib/ai-gateway/auto-model';
import type { KiloClawDashboardStatus } from '@/lib/kiloclaw/types';
import { controllerVersionOk, gatewayStatusOk } from '@/lib/kiloclaw/types';
import { useKiloClawGatewayStatus, useKiloClawMutations } from '@/hooks/useKiloClaw';
import { useOrgKiloClawGatewayStatus, useOrgKiloClawMutations } from '@/hooks/useOrgKiloClaw';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useClawControllerVersion, useClawServiceDegraded } from '../hooks/useClawHooks';
import { useOnboardingSaves } from '../hooks/useOnboardingSaves';
import { useGatewayUrl } from '../hooks/useGatewayUrl';
import { BillingWrapper } from './billing/BillingWrapper';
import { BotIdentityStep } from './BotIdentityStep';
import { CalendarConnectStepView } from './CalendarConnectStep';
import { InboundEmailStepView } from './InboundEmailStep';
import { InterestsStepView } from './InterestsStep';
import {
  INTEREST_TOPIC_PRESETS,
  MORNING_BRIEFING_INTERESTS_MIN_CONTROLLER_VERSION,
} from '@/lib/kiloclaw/morning-briefing-interests';
import { controllerCalverSupports } from '@/lib/kiloclaw/version';
import { ClawContextProvider, useClawContext } from './ClawContext';
import { ClawConfigServiceBanner } from './ClawConfigServiceBanner';
import { ClawHeader } from './ClawHeader';
import { ProvisioningStep, ProvisioningStepView } from './ProvisioningStep';
import { DEFAULT_BOT_IDENTITY, DEFAULT_ONBOARDING_EXEC_PRESET } from './claw.types';
import type { BotIdentity, ExecPreset } from './claw.types';
import {
  getClawOnboardingFlowState,
  type ClawOnboardingMode,
  type OnboardingStep,
} from './ClawOnboardingFlow.state';

function MaybeBillingWrapper({
  skip,
  hideBanners,
  children,
}: {
  skip: boolean;
  hideBanners: boolean;
  children: React.ReactNode;
}) {
  if (skip) return <>{children}</>;
  return <BillingWrapper hideBanners={hideBanners}>{children}</BillingWrapper>;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled KiloClaw onboarding render step: ${value}`);
}

function getBrowserTimeZone(): string | undefined {
  try {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof timeZone === 'string' && timeZone.trim() ? timeZone : undefined;
  } catch {
    return undefined;
  }
}

export type { ClawOnboardingMode };

export function ClawOnboardingFlow({
  status,
  mode,
  organizationId,
  createFlowStarted = false,
  setupFailed = false,
  onCreateFlowStarted,
  onCreateFlowFailed,
}: {
  status: KiloClawDashboardStatus | undefined;
  mode: ClawOnboardingMode;
  organizationId?: string;
  createFlowStarted?: boolean;
  setupFailed?: boolean;
  onCreateFlowStarted?: () => void;
  onCreateFlowFailed?: () => void;
}) {
  return (
    <ClawContextProvider organizationId={organizationId}>
      <ClawOnboardingFlowInner
        status={status}
        mode={mode}
        createFlowStarted={createFlowStarted}
        setupFailed={setupFailed}
        onCreateFlowStarted={onCreateFlowStarted}
        onCreateFlowFailed={onCreateFlowFailed}
      />
    </ClawContextProvider>
  );
}

function ClawOnboardingFlowInner({
  status,
  mode,
  createFlowStarted,
  setupFailed,
  onCreateFlowStarted,
  onCreateFlowFailed,
}: {
  status: KiloClawDashboardStatus | undefined;
  mode: ClawOnboardingMode;
  createFlowStarted: boolean;
  setupFailed: boolean;
  onCreateFlowStarted?: () => void;
  onCreateFlowFailed?: () => void;
}) {
  const { organizationId } = useClawContext();

  const personalMutations = useKiloClawMutations();
  const orgMutations = useOrgKiloClawMutations(organizationId ?? '');
  const mutations = organizationId ? orgMutations : personalMutations;
  const searchParams = useSearchParams();

  const hasCalendarStep = true;
  // Morning briefing is generally available — the Interests step shows for
  // all users (it still gates on controller version below).
  // Gate on controller version. The plugin route that backs
  // updateBriefingInterests is only present on images >= the minimum
  // version below. Without this check, an admin onboarding an older
  // image would hit a 404 on save. Default to "supports" while loading
  // so the step doesn't briefly disappear mid-wizard. The version
  // endpoint proxies through the gateway, so only fetch once the
  // instance is running — before that the query stays pending and the
  // optimistic default applies.
  const controllerVersionQuery = useClawControllerVersion(status?.status === 'running');
  // Narrow off the instance-not-running sentinel so `.version` is safe.
  const controllerVersion = controllerVersionOk(controllerVersionQuery.data);
  // Fail OPEN: keep the interests step unless the controller version is
  // positively parsed as too old, OR the worker reports an explicit
  // `version: null` (its positive old-controller signal for a missing
  // `/_kilo/version` route). Still-loading / errored / unparseable
  // versions stay optimistic; the worker's `controller_route_unavailable`
  // 404 on save is the backstop for those.
  const controllerSupportsInterests = controllerCalverSupports(
    controllerVersion?.version,
    MORNING_BRIEFING_INTERESTS_MIN_CONTROLLER_VERSION
  );
  const hasInterestsStep = controllerSupportsInterests;
  // Lazy-init onboardingStep from `?step=` in the URL so first render already
  // reflects a calendar resume. Without this the state machine would resolve
  // to 'complete' (post-provisioning + ready) on first render and the auto-
  // redirect to /chat would fire before the resume effect's setOnboardingStep
  // could take effect, skipping the calendar success/error feedback entirely.
  const [onboardingStep, setOnboardingStep] = useState<OnboardingStep>(() => {
    if (typeof window === 'undefined') return 'identity';
    const initialStep = new URLSearchParams(window.location.search).get('step');
    if (initialStep === 'tools') return 'tools';
    return initialStep === 'calendar' ? 'calendar' : 'identity';
  });
  const hasToolsStep = false;

  const gatewayUrl = useGatewayUrl(status);

  const selectedPreset: ExecPreset = DEFAULT_ONBOARDING_EXEC_PRESET;
  const [botIdentity, setBotIdentity] = useState<BotIdentity | null>(null);
  const [pendingUserLocation, setPendingUserLocation] = useState<string | null>(null);
  // Interest topics chosen on the Interests step are deferred until the
  // provisioning step completes — the plugin endpoint that backs
  // `updateBriefingInterests` isn't reachable until the instance gateway
  // is running, and trying to save mid-wizard hits `gateway_warming_up`
  // (503). The save fires inside `ProvisioningStep.onComplete`, which
  // only runs after the instance is fully ready.
  const [pendingInterests, setPendingInterests] = useState<string[] | null>(null);
  const [localCreateSetupStarted, setLocalCreateSetupStarted] = useState(false);
  const [onboardingSaveSession, setOnboardingSaveSession] = useState(0);
  const hasCapturedIdentityView = useRef(false);
  const hasCapturedCalendarView = useRef(false);
  const hasCapturedEmailView = useRef(false);
  const hasCapturedInterestsView = useRef(false);
  const hasCapturedDoneView = useRef(false);
  const createSetupStarted = createFlowStarted || localCreateSetupStarted;

  const stateInput = {
    status,
    mode,
    createSetupStarted,
    setupFailed,
    onboardingStep,
    hasBotIdentity: botIdentity !== null,
    hasToolsStep,
    hasCalendarStep,
    hasInterestsStep,
  };
  const preGatewayFlowState = getClawOnboardingFlowState({
    ...stateInput,
    gatewayState: null,
    debugLogSource: 'pre-gateway',
  });

  const personalGateway = useKiloClawGatewayStatus(
    !organizationId && preGatewayFlowState.isRunning
  );
  const orgGateway = useOrgKiloClawGatewayStatus(
    organizationId ?? '',
    !!organizationId && preGatewayFlowState.isRunning
  );
  const { data: gatewayStatusRaw } = organizationId ? orgGateway : personalGateway;
  const gatewayStatus = gatewayStatusOk(gatewayStatusRaw);
  const flowState = getClawOnboardingFlowState({
    ...stateInput,
    gatewayState: gatewayStatus?.state ?? null,
    debugLogSource: 'gateway',
  });

  const { data: isServiceDegraded } = useClawServiceDegraded();
  useFeatureFlagVariantKey('button-vs-card');
  const posthog = usePostHog();
  const router = useRouter();
  const pathname = usePathname();

  // Save bot identity and exec preset as soon as the instance row exists.
  // This closes the tab-close window where customizations entered during the
  // provisioning spinner could otherwise be lost with the unmounted
  // ProvisioningStep. Channel tokens used to live here too; they're now
  // dropped from the active flow but useOnboardingSaves still accepts the
  // arg as null so we don't need to touch the hook.
  const onboardingSaves = useOnboardingSaves({
    hasInstance: flowState.instanceStatus !== null,
    botIdentity,
    selectedPreset,
    channelTokens: null,
    resetKey: `${onboardingSaveSession}:${
      flowState.instanceStatus?.instanceId ?? flowState.instanceStatus?.sandboxId ?? 'pending'
    }`,
    mutations,
  });

  useEffect(() => {
    if (flowState.renderStep !== 'identity' || hasCapturedIdentityView.current) return;
    hasCapturedIdentityView.current = true;
    posthog?.capture('claw_page_viewed');
    posthog?.capture('claw_setup_identity_viewed');
  }, [flowState.renderStep, posthog]);

  // Fire `claw_setup_calendar_viewed` when the calendar step actually
  // renders, matching the "viewed = rendered" semantic of identity above
  // (and unlike the older advance-fire pattern still used by provisioning).
  // Ref guard so re-renders inside the step don't re-fire.
  useEffect(() => {
    if (flowState.renderStep !== 'calendar' || hasCapturedCalendarView.current) return;
    hasCapturedCalendarView.current = true;
    posthog?.capture('claw_setup_calendar_viewed');
  }, [flowState.renderStep, posthog]);

  // Same pattern for the inbound email step.
  useEffect(() => {
    if (flowState.renderStep !== 'email' || hasCapturedEmailView.current) return;
    hasCapturedEmailView.current = true;
    posthog?.capture('claw_setup_email_viewed');
  }, [flowState.renderStep, posthog]);

  // Same pattern for the interests step.
  useEffect(() => {
    if (flowState.renderStep !== 'interests' || hasCapturedInterestsView.current) return;
    hasCapturedInterestsView.current = true;
    posthog?.capture('claw_setup_interests_viewed');
  }, [flowState.renderStep, posthog]);

  useEffect(() => {
    if (
      mode !== 'post-provisioning' ||
      !flowState.postProvisioningReady ||
      hasCapturedDoneView.current
    ) {
      return;
    }
    hasCapturedDoneView.current = true;
    posthog?.capture('claw_setup_done_viewed');
  }, [mode, flowState.postProvisioningReady, posthog]);

  const resetWizardSelections = useCallback(() => {
    setOnboardingStep('identity');
    setBotIdentity(null);
    setPendingUserLocation(null);
  }, []);

  const handleCreateFlowStarted = useCallback(() => {
    setLocalCreateSetupStarted(true);
    setOnboardingSaveSession(value => value + 1);
    onCreateFlowStarted?.();
  }, [onCreateFlowStarted]);

  const handleCreateFlowFailed = useCallback(() => {
    setLocalCreateSetupStarted(false);
    hasCapturedIdentityView.current = false;
    resetWizardSelections();
    onCreateFlowFailed?.();
  }, [onCreateFlowFailed, resetWizardSelections]);

  const basePath = organizationId ? `/organizations/${organizationId}/claw` : '/claw';

  // Hydrate local bot-identity state from the persisted instance status when
  // the page reloads mid-onboarding (e.g. after the OAuth round-trip on the
  // calendar step). useOnboardingSaves writes the user's identity selections
  // to the backend; without this, a remount would force the user back to the
  // identity step even though their picks were already saved.
  useEffect(() => {
    if (botIdentity !== null) return;
    const persisted = flowState.instanceStatus;
    if (!persisted?.botName) return;
    setBotIdentity({
      botName: persisted.botName,
      botNature: persisted.botNature ?? DEFAULT_BOT_IDENTITY.botNature,
      botVibe: persisted.botVibe ?? DEFAULT_BOT_IDENTITY.botVibe,
      botEmoji: persisted.botEmoji ?? DEFAULT_BOT_IDENTITY.botEmoji,
    });
  }, [flowState.instanceStatus, botIdentity]);

  // Resume the calendar step after the full-page Google OAuth round trip.
  // Stale Composio callback URLs are cleaned up without showing connection
  // feedback because Composio is no longer part of onboarding.
  const hasResumedFromQuery = useRef(false);

  // Allowlist of known OAuth error codes that the callback route can emit.
  // Anything else from `?error=` is bucketed as 'unknown' before going to
  // PostHog so an attacker can't pollute analytics with arbitrary strings.
  const KNOWN_OAUTH_ERROR_CODES = [
    'access_denied',
    'oauth_error',
    'missing_code',
    'missing_instance',
    'missing_permissions',
    'connection_failed',
    'invalid_state',
    'unauthorized',
  ];
  const cleanupResumeQueryParams = useCallback(() => {
    const next = new URLSearchParams(searchParams?.toString() ?? '');
    next.delete('step');
    next.delete('success');
    next.delete('error');
    const nextSearch = next.toString();
    router.replace(nextSearch ? `${pathname}?${nextSearch}` : (pathname ?? '/claw/new'));
  }, [pathname, router, searchParams]);

  useEffect(() => {
    if (hasResumedFromQuery.current) return;
    const stepParam = searchParams?.get('step');
    if (stepParam === 'tools') {
      hasResumedFromQuery.current = true;
      cleanupResumeQueryParams();
      return;
    }
    if (stepParam !== 'calendar' || botIdentity === null) return;
    const successParam = searchParams?.get('success');
    const errorParamRaw = searchParams?.get('error');
    const errorReason = errorParamRaw
      ? KNOWN_OAUTH_ERROR_CODES.includes(errorParamRaw)
        ? errorParamRaw
        : 'unknown'
      : null;
    hasResumedFromQuery.current = true;
    setOnboardingStep('calendar');
    posthog?.capture('claw_setup_calendar_resumed', {
      outcome: successParam ? 'connected' : errorParamRaw ? 'error' : 'unknown',
    });
    if (successParam === 'google_connected') {
      posthog?.capture('claw_setup_calendar_oauth_completed');
      toast.success('Calendar connected');
    } else if (errorParamRaw) {
      posthog?.capture('claw_setup_calendar_oauth_failed', { reason: errorReason });
      toast.error(
        errorReason === 'missing_permissions'
          ? 'Calendar permission was not granted. Allow Calendar access to connect or skip for now.'
          : 'Could not connect calendar. Try again or skip for now.'
      );
    }
    cleanupResumeQueryParams();
  }, [searchParams, botIdentity, posthog, cleanupResumeQueryParams]);

  // NOTE: When mode === 'post-provisioning' (i.e. an existing instance is
  // already running) and the gateway is ready, renderStep is 'complete' on
  // first render and the redirect below fires immediately. This is intentional:
  // the onboarding wizard is for new users; returning users with a working
  // instance go straight to chat rather than seeing a wizard surface.
  const hasRedirectedToChat = useRef(false);
  useEffect(() => {
    // Wait for the gateway to actually be ready before redirecting; the chat
    // page's conversation requests will hang indefinitely if the gateway is
    // still warming up.
    if (
      flowState.renderStep !== 'complete' ||
      !flowState.gatewayReady ||
      hasRedirectedToChat.current
    ) {
      return;
    }
    hasRedirectedToChat.current = true;
    posthog?.capture('claw_setup_open_chat_clicked', { auto_redirect: true });

    // Only a freshly-onboarded user (`create-first` mode) gets the morning
    // briefing as their first chat message. Returning users resolving to
    // `complete` in `post-provisioning` mode just go straight to chat.
    if (mode !== 'create-first') {
      router.push(`${basePath}/chat`);
      return;
    }

    // Kick off the in-chat onboarding briefing: this creates the "Today's
    // briefing" conversation and starts generation, then we route the user
    // straight into it. Best effort — any failure falls back to the plain
    // chat redirect (PR-1 behavior) so onboarding never gets stuck here.
    void (async () => {
      let target = `${basePath}/chat`;
      try {
        const result = await mutations.startOnboardingBriefing.mutateAsync();
        if (result?.conversationId) {
          target = `${basePath}/chat/${result.conversationId}`;
        }
      } catch {
        // Fall through to the plain chat redirect.
      }
      router.push(target);
    })();
  }, [flowState.renderStep, flowState.gatewayReady, basePath, router, posthog, mode, mutations]);

  function provisionInstance(userLocation?: string) {
    posthog?.capture('claw_create_instance_clicked', {
      selected_model: KILO_AUTO_BALANCED_MODEL.id,
    });
    handleCreateFlowStarted();

    mutations.provision.mutate(
      {
        kilocodeDefaultModel: `kilocode/${KILO_AUTO_BALANCED_MODEL.id}`,
        userTimezone: getBrowserTimeZone(),
        ...(userLocation ? { userLocation } : undefined),
      },
      {
        onError: err => {
          posthog?.capture('claw_setup_provision_failed', {
            selected_model: KILO_AUTO_BALANCED_MODEL.id,
            reason: 'provision_request_failed',
          });
          handleCreateFlowFailed();
          toast.error(`Failed to create: ${err.message}`);
        },
      }
    );
  }

  function startProvisionForCreateFlow() {
    if (mode !== 'create-first' || flowState.instanceStatus !== null || createSetupStarted) return;
    provisionInstance(pendingUserLocation ?? undefined);
  }

  function renderIdentityStep() {
    return (
      <BotIdentityStep
        currentStep={flowState.currentStep}
        totalSteps={flowState.totalSteps}
        onContinue={({ identity, weatherLocation }) => {
          posthog?.capture('claw_setup_identity_completed', {
            bot_name_is_custom: identity.botName !== 'KiloClaw',
            bot_nature: identity.botNature,
            bot_emoji_is_custom: identity.botEmoji !== '🤖',
          });
          if (weatherLocation) {
            posthog?.capture('claw_weather_location_selected', { source: weatherLocation.source });
          } else {
            posthog?.capture('claw_weather_location_skipped');
          }

          if (flowState.instanceStatus) {
            if (weatherLocation) {
              mutations.updateConfig.mutate(
                { userLocation: weatherLocation.location },
                { onError: err => toast.error(err.message) }
              );
            }
          } else {
            setPendingUserLocation(weatherLocation?.location ?? null);
          }
          posthog?.capture('claw_setup_permissions_completed', {
            preset: DEFAULT_ONBOARDING_EXEC_PRESET,
            defaulted: true,
          });
          setBotIdentity(identity);
          if (hasCalendarStep) {
            if (!flowState.instanceStatus) {
              provisionInstance(weatherLocation?.location);
            }
            setOnboardingStep('calendar');
          } else {
            if (!flowState.instanceStatus) {
              provisionInstance(weatherLocation?.location);
            }
            setOnboardingStep('email');
          }
        }}
      />
    );
  }

  function renderCalendarStep() {
    const returnTo = `${basePath}/new?step=calendar`;
    const connectParams = new URLSearchParams({ returnTo });
    if (organizationId) {
      connectParams.set('organizationId', organizationId);
    }
    const connectUrl = `/api/integrations/google/connect?${connectParams.toString()}`;
    const isConnected = Boolean(flowState.instanceStatus?.googleOAuthConnected);
    const connectedEmail = flowState.instanceStatus?.googleOAuthAccountEmail ?? null;

    function advanceToEmail() {
      startProvisionForCreateFlow();
      setOnboardingStep('email');
    }

    return (
      <CalendarConnectStepView
        currentStep={flowState.currentStep}
        totalSteps={flowState.totalSteps}
        connectUrl={connectUrl}
        isConnected={isConnected}
        connectedAccountEmail={connectedEmail}
        readyToConnect={flowState.instanceStatus !== null && onboardingSaves.ready}
        onConnectClick={() => {
          posthog?.capture('claw_setup_calendar_connect_clicked', { skipped: false });
        }}
        onSkip={() => {
          posthog?.capture('claw_setup_calendar_completed', { connected: false, skipped: true });
          advanceToEmail();
        }}
        onContinue={() => {
          posthog?.capture('claw_setup_calendar_completed', { connected: true, skipped: false });
          advanceToEmail();
        }}
      />
    );
  }

  function renderEmailStep() {
    // Loading = platform status hasn't returned yet (instanceStatus null) OR
    // the alias hasn't propagated despite the feature being enabled. Either
    // way, the address can't be displayed; gate Continue so users don't
    // skip the screen during the brief window before the alias appears.
    const persisted = flowState.instanceStatus;
    const inboundEmailAddress = persisted?.inboundEmailAddress ?? null;
    const inboundEmailEnabled = persisted?.inboundEmailEnabled ?? false;
    const loading = persisted === null || (inboundEmailEnabled && inboundEmailAddress === null);

    return (
      <InboundEmailStepView
        currentStep={flowState.currentStep}
        totalSteps={flowState.totalSteps}
        address={inboundEmailAddress}
        enabled={inboundEmailEnabled}
        loading={loading}
        onCopyClick={() => {
          posthog?.capture('claw_setup_email_address_copied');
        }}
        onContinue={() => {
          posthog?.capture('claw_setup_email_completed');
          if (hasInterestsStep) {
            setOnboardingStep('interests');
          } else {
            posthog?.capture('claw_setup_provisioning_viewed');
            setOnboardingStep('provisioning');
          }
        }}
      />
    );
  }

  function renderInterestsStep() {
    function advanceToProvisioning() {
      posthog?.capture('claw_setup_provisioning_viewed');
      setOnboardingStep('provisioning');
    }
    return (
      <InterestsStepView
        currentStep={flowState.currentStep}
        totalSteps={flowState.totalSteps}
        // Save is deferred to ProvisioningStep.onComplete; the step itself
        // never roundtrips. No "saving" state needed.
        saving={false}
        onContinue={topics => {
          const hasCustom = topics.some(
            topic =>
              !INTEREST_TOPIC_PRESETS.some(preset => preset.toLowerCase() === topic.toLowerCase())
          );
          posthog?.capture('claw_setup_interests_completed', {
            topics_count: topics.length,
            has_custom: hasCustom,
          });
          // Stash topics. Empty array → null (no deferred save needed
          // since the column default is `'{}'` anyway).
          setPendingInterests(topics.length > 0 ? topics : null);
          advanceToProvisioning();
        }}
        onSkip={() => {
          posthog?.capture('claw_setup_interests_skipped');
          setPendingInterests(null);
          advanceToProvisioning();
        }}
      />
    );
  }

  function renderProvisioningStep() {
    // Static ProvisioningStepView is only for the original post-provisioning
    // case (returning user lands on /claw/new with an active instance — the
    // state machine flips to 'complete' separately and PR-1's auto-redirect
    // takes over). When a wizard resume after an OAuth round-trip reaches
    // the provisioning step explicitly (onboardingStep === 'provisioning'),
    // use the full ProvisioningStep so its onComplete fires and the user
    // actually advances to done instead of getting stuck.
    if (mode === 'post-provisioning' && onboardingStep !== 'provisioning')
      return (
        <ProvisioningStepView
          currentStep={flowState.currentStep}
          totalSteps={flowState.totalSteps}
        />
      );

    return (
      <ProvisioningStep
        currentStep={flowState.currentStep}
        totalSteps={flowState.totalSteps}
        onboardingSavesReady={onboardingSaves.ready}
        instanceRunning={flowState.instanceRunning}
        onComplete={async () => {
          // Flush deferred interests now that the instance + gateway are
          // ready (ProvisioningStep only calls onComplete after
          // `instanceRunning` is true, and `instanceRunning` already
          // includes `gatewayReady` per state.ts). If a save fails for
          // any reason, surface a toast but don't block — the user can
          // re-save from Settings.
          //
          // If the user picked any topics during onboarding, treat that
          // as explicit "I want daily briefings" intent and auto-enable
          // the briefing with their browser timezone. Schedule defaults
          // to the plugin's `'0 7 * * *'`; user can adjust both from
          // Settings later. Empty topics / Skip => no auto-enable.
          const topicsToPersist = pendingInterests;
          setPendingInterests(null);
          if (topicsToPersist !== null) {
            try {
              await mutations.updateBriefingInterests.mutateAsync({ topics: topicsToPersist });
            } catch (err) {
              toast.error(
                `Could not save interests: ${
                  err instanceof Error ? err.message : String(err)
                }. You can add them later in Settings.`
              );
            }
            try {
              await mutations.enableMorningBriefing.mutateAsync({
                timezone: getBrowserTimeZone(),
              });
            } catch (err) {
              // Silent fallback — the user picked topics, not an
              // explicit Enable button, so we don't pile a second toast
              // on top of any interests-save error. They can flip the
              // toggle from Settings if needed.
              console.warn('Auto-enable morning briefing failed:', err);
            }
          }
          posthog?.capture('claw_setup_provisioned');
          posthog?.capture('claw_setup_done_viewed');
          setOnboardingStep('done');
        }}
      />
    );
  }

  function renderCompleteStep() {
    return <ClawSetupCompleteStep gatewayReady={flowState.gatewayReady} />;
  }

  function renderErrorStep() {
    return <ClawSetupErrorStep basePath={basePath} />;
  }

  function renderStepContent() {
    const renderStep = flowState.renderStep;

    switch (renderStep) {
      case 'identity':
        return renderIdentityStep();
      case 'tools':
      case 'calendar':
        return renderCalendarStep();
      case 'email':
        return renderEmailStep();
      case 'interests':
        return renderInterestsStep();
      case 'provisioning':
        return renderProvisioningStep();
      case 'complete':
        return renderCompleteStep();
      case 'error':
        return renderErrorStep();
      default:
        return assertNever(renderStep);
    }
  }

  return (
    <div className="container m-auto flex w-full max-w-[1140px] flex-col gap-6 p-4 md:p-6">
      <ClawHeader
        status={status?.status || null}
        sandboxId={status?.sandboxId || null}
        region={status?.flyRegion || null}
        gatewayUrl={gatewayUrl}
        gatewayReady={flowState.gatewayReady}
        isSetupWizard
      />

      {isServiceDegraded && (
        <Alert variant="warning">
          <TriangleAlert className="size-4" />
          <AlertDescription>
            <span>
              KiloClaw is really popular today. If you run into issues,{' '}
              <a
                href="https://status.kilo.ai/"
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:opacity-80"
              >
                check our status page
              </a>{' '}
              for live updates.
            </span>
          </AlertDescription>
        </Alert>
      )}

      <ClawConfigServiceBanner status={status} />

      <MaybeBillingWrapper skip={!!organizationId} hideBanners>
        {renderStepContent()}
      </MaybeBillingWrapper>
    </div>
  );
}

export function ClawSetupErrorStep({ basePath }: { basePath: string }) {
  return (
    <Card className="mt-6 overflow-hidden">
      <CardContent className="flex flex-col items-center justify-center gap-6 pt-12">
        <div className="flex h-20 w-20 items-center justify-center rounded-2xl border border-destructive/30 bg-destructive/10">
          <div className="flex h-12 w-12 items-center justify-center rounded-full border-2 border-destructive">
            <TriangleAlert className="h-6 w-6 text-destructive" />
          </div>
        </div>

        <div className="flex flex-col items-center gap-2">
          <h2 className="text-2xl font-bold">Something went wrong</h2>
          <p className="text-muted-foreground max-w-md text-center">
            Your KiloClaw instance stopped or failed during setup. Please reach out to support for
            help getting it back online.
          </p>
        </div>

        <div className="flex w-full flex-col gap-3">
          <Button asChild variant="primary" className="w-full min-w-[180px] py-6 text-base">
            <a href="https://kilo.ai/support" target="_blank" rel="noopener noreferrer">
              Contact Support
            </a>
          </Button>
          <Button asChild className="w-full py-6 text-base" variant="outline">
            <Link href={basePath}>
              <X className="mr-2 h-4 w-4" />
              Close Wizard
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// Renders the "complete" step in the onboarding flow. Production use is brief:
// it shows during the warmup window after provisioning finishes, then the
// auto-redirect effect in ClawOnboardingFlowInner pushes the user to /chat as
// soon as gatewayReady flips true. Also rendered by ClawOnboardingFakeWalkthrough
// so designers can preview this state.
export function ClawSetupCompleteStep({ gatewayReady }: { gatewayReady: boolean }) {
  return (
    <Card className="mt-6 overflow-hidden">
      <CardContent className="flex flex-col items-center justify-center gap-4 pt-12">
        <Loader2 className="text-muted-foreground h-8 w-8 animate-spin" />
        <p className="text-muted-foreground text-sm">
          {gatewayReady ? 'Opening chat…' : 'Almost ready — finishing up your instance…'}
        </p>
      </CardContent>
    </Card>
  );
}
