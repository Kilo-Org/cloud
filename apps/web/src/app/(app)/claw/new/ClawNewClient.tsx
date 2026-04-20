'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useKiloClawStatus } from '@/hooks/useKiloClaw';
import { useUser } from '@/hooks/useUser';
import { useTRPC } from '@/lib/trpc/utils';
import {
  clearPersonalOnboardingInProgress,
  markPersonalOnboardingInProgress,
  readPersonalOnboardingInProgress,
} from '@/lib/kiloclaw/onboarding-progress';
import {
  ClawOnboardingFlow,
  type ClawOnboardingMode,
  withStatusQueryBoundary,
} from '../components';
import type { ClawOnboardingRenderStep } from '../components/ClawOnboardingFlow.state';
import { ClawOnboardingFakeWalkthrough } from '../components/ClawOnboardingFakeWalkthrough';
import { WelcomePage } from '../components/billing/WelcomePage';

const ClawOnboardingWithBoundary = withStatusQueryBoundary(ClawOnboardingFlow);

export function getCreateFlowStartedAtFromMarker(
  markerForCurrentUser: boolean,
  now: () => number = Date.now
): number | null {
  return markerForCurrentUser ? now() : null;
}

export function getClawNewMode({
  createFlowStartedAt,
  hasActiveInstance,
  onboardingInProgress,
}: {
  createFlowStartedAt: number | null;
  hasActiveInstance: boolean;
  onboardingInProgress: boolean;
}): ClawOnboardingMode {
  return createFlowStartedAt !== null || !hasActiveInstance || onboardingInProgress
    ? 'create-first'
    : 'post-provisioning';
}

export function getCreateFirstFlowFlags({
  mode,
  autoStartFailed,
  onboardingInProgress,
  hasActiveInstance,
}: {
  mode: ClawOnboardingMode;
  autoStartFailed: boolean;
  onboardingInProgress: boolean;
  hasActiveInstance: boolean;
}): {
  skipCreateInstanceStep: boolean;
  autoProvisionOnMount: boolean;
} {
  return {
    skipCreateInstanceStep: mode === 'create-first' && !autoStartFailed,
    autoProvisionOnMount:
      mode === 'create-first' && !autoStartFailed && !onboardingInProgress && !hasActiveInstance,
  };
}

export function shouldApplyCreateFlowCallback({
  activeUserId,
  callbackUserId,
}: {
  activeUserId: string | null;
  callbackUserId: string | null;
}): boolean {
  return activeUserId === callbackUserId;
}

function LoadingState() {
  return (
    <div
      className="container m-auto flex w-full max-w-[1140px] items-center justify-center p-4 md:p-6"
      style={{ minHeight: '50vh' }}
    >
      <Loader2 className="text-muted-foreground h-8 w-8 animate-spin" />
    </div>
  );
}

function ClawNewLoader({
  mode,
  createFlowStartedAt,
  billingUpdatedAt,
  skipCreateInstanceStep,
  autoProvisionOnMount,
  onCreateFlowStarted,
  onCreateFlowFailed,
  onCreateFlowComplete,
}: {
  mode: ClawOnboardingMode;
  createFlowStartedAt: number | null;
  billingUpdatedAt: number;
  skipCreateInstanceStep: boolean;
  autoProvisionOnMount: boolean;
  onCreateFlowStarted: () => void;
  onCreateFlowFailed: () => void;
  onCreateFlowComplete: () => void;
}) {
  const statusQuery = useKiloClawStatus();

  if (mode === 'create-first') {
    const status =
      createFlowStartedAt !== null && statusQuery.dataUpdatedAt >= createFlowStartedAt
        ? statusQuery.data
        : undefined;

    return (
      <ClawOnboardingFlow
        status={status}
        mode={mode}
        createFlowStarted={createFlowStartedAt !== null}
        skipCreateInstanceStep={skipCreateInstanceStep}
        autoProvisionOnMount={autoProvisionOnMount}
        onCreateFlowStarted={onCreateFlowStarted}
        onCreateFlowFailed={onCreateFlowFailed}
        onCreateFlowComplete={onCreateFlowComplete}
      />
    );
  }

  const statusQueryForBoundary =
    statusQuery.error || statusQuery.dataUpdatedAt >= billingUpdatedAt
      ? statusQuery
      : {
          data: undefined,
          isLoading: true,
          error: null,
        };

  return (
    <ClawOnboardingWithBoundary
      statusQuery={statusQueryForBoundary}
      mode={mode}
      createFlowStarted={createFlowStartedAt !== null}
      skipCreateInstanceStep={skipCreateInstanceStep}
      autoProvisionOnMount={autoProvisionOnMount}
      onCreateFlowStarted={onCreateFlowStarted}
      onCreateFlowFailed={onCreateFlowFailed}
      onCreateFlowComplete={onCreateFlowComplete}
    />
  );
}

export function ClawNewClient({
  fakeOnboardingStep,
}: {
  fakeOnboardingStep: ClawOnboardingRenderStep | null;
}) {
  if (fakeOnboardingStep) {
    return <ClawOnboardingFakeWalkthrough initialStep={fakeOnboardingStep} basePath="/claw" />;
  }

  return <ClawNewLiveClient />;
}

function ClawNewLiveClient() {
  const trpc = useTRPC();
  const { data: user, isLoading: userLoading } = useUser();
  const billingQuery = useQuery(trpc.kiloclaw.getBillingStatus.queryOptions());
  const currentUserId = user?.id ?? null;
  const currentUserIdRef = useRef<string | null>(currentUserId);
  const [onboardingInProgress, setOnboardingInProgress] = useState(false);
  // Re-seed `createFlowStartedAt` when resuming onboarding after a refresh so
  // `ClawNewLoader`'s status timestamp filter lets fresh status data through.
  const [createFlowStartedAt, setCreateFlowStartedAt] = useState<number | null>(null);
  // Falls back to showing the legacy intro card when auto-start fails so the
  // user still has a manual retry button.
  const [autoStartFailed, setAutoStartFailed] = useState(false);

  useEffect(() => {
    currentUserIdRef.current = currentUserId;
  }, [currentUserId]);

  useEffect(() => {
    if (userLoading) return;

    const markerForCurrentUser = readPersonalOnboardingInProgress(currentUserId);
    setOnboardingInProgress(markerForCurrentUser);
    setCreateFlowStartedAt(getCreateFlowStartedAtFromMarker(markerForCurrentUser));
    setAutoStartFailed(false);
  }, [currentUserId, userLoading]);

  const onCreateFlowStarted = useCallback(() => {
    const callbackUserId = currentUserId;
    markPersonalOnboardingInProgress(currentUserId);
    if (
      !shouldApplyCreateFlowCallback({
        activeUserId: currentUserIdRef.current,
        callbackUserId,
      })
    ) {
      return;
    }
    setOnboardingInProgress(true);
    setAutoStartFailed(false);
    setCreateFlowStartedAt(Date.now());
  }, [currentUserId]);

  const onCreateFlowFailed = useCallback(() => {
    const callbackUserId = currentUserId;
    clearPersonalOnboardingInProgress(currentUserId);
    if (
      !shouldApplyCreateFlowCallback({
        activeUserId: currentUserIdRef.current,
        callbackUserId,
      })
    ) {
      return;
    }
    setOnboardingInProgress(false);
    setAutoStartFailed(true);
    setCreateFlowStartedAt(null);
  }, [currentUserId]);

  const handleCreateFlowComplete = useCallback(() => {
    const callbackUserId = currentUserId;
    clearPersonalOnboardingInProgress(currentUserId);
    if (
      !shouldApplyCreateFlowCallback({
        activeUserId: currentUserIdRef.current,
        callbackUserId,
      })
    ) {
      return;
    }
    setOnboardingInProgress(false);
    setCreateFlowStartedAt(null);
  }, [currentUserId]);

  if (userLoading || billingQuery.isLoading) {
    return <LoadingState />;
  }

  if (billingQuery.isError) {
    return (
      <div
        className="container m-auto flex w-full max-w-[1140px] items-center justify-center p-4 md:p-6"
        style={{ minHeight: '50vh' }}
      >
        <p className="text-destructive text-sm">
          Unable to load billing status. Please refresh the page or try again later.
        </p>
      </div>
    );
  }

  if (createFlowStartedAt === null && billingQuery.isFetching) {
    return <LoadingState />;
  }

  const billing = billingQuery.data;
  const isNewUser =
    billing &&
    !billing.hasAccess &&
    billing.instance === null &&
    !billing.earlybird &&
    !billing.trial?.expired;

  if (isNewUser && !billing.trialEligible) {
    return (
      <div className="container m-auto flex w-full max-w-[1140px] flex-col gap-6 p-4 md:p-6">
        <WelcomePage />
      </div>
    );
  }

  const hasActiveInstance =
    billing?.instance?.exists === true && billing.instance.destroyed === false;
  const mode = getClawNewMode({
    createFlowStartedAt,
    hasActiveInstance,
    onboardingInProgress,
  });

  // Show identity (not the intro card) as the first screen whenever the
  // personal create-first wizard is shown — including refreshes during an
  // in-progress session. Falls back to the legacy intro card only if
  // auto-start has failed, so the user still has a manual retry button.
  const { skipCreateInstanceStep, autoProvisionOnMount } = getCreateFirstFlowFlags({
    mode,
    autoStartFailed,
    onboardingInProgress,
    hasActiveInstance,
  });

  return (
    <ClawNewLoader
      mode={mode}
      createFlowStartedAt={createFlowStartedAt}
      billingUpdatedAt={billingQuery.dataUpdatedAt}
      skipCreateInstanceStep={skipCreateInstanceStep}
      autoProvisionOnMount={autoProvisionOnMount}
      onCreateFlowStarted={onCreateFlowStarted}
      onCreateFlowFailed={onCreateFlowFailed}
      onCreateFlowComplete={handleCreateFlowComplete}
    />
  );
}
