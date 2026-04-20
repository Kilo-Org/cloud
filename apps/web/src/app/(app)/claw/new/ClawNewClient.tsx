'use client';

import { useCallback, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useKiloClawStatus } from '@/hooks/useKiloClaw';
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
}: {
  mode: ClawOnboardingMode;
  createFlowStartedAt: number | null;
  billingUpdatedAt: number;
  skipCreateInstanceStep: boolean;
  autoProvisionOnMount: boolean;
  onCreateFlowStarted: () => void;
  onCreateFlowFailed: () => void;
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
  const billingQuery = useQuery(trpc.kiloclaw.getBillingStatus.queryOptions());
  // Lazy init so the first client render sees the correct refresh-safety
  // value. `safeLocalStorage` returns null on the server, so SSR still renders
  // with `false` and hydration stays in sync.
  const [onboardingInProgress, setOnboardingInProgress] = useState<boolean>(() =>
    readPersonalOnboardingInProgress()
  );
  // Re-seed `createFlowStartedAt` when resuming onboarding after a refresh so
  // `ClawNewLoader`'s status timestamp filter lets fresh status data through
  // — otherwise the provisioning step cannot detect `instanceRunning`.
  const [createFlowStartedAt, setCreateFlowStartedAt] = useState<number | null>(() =>
    readPersonalOnboardingInProgress() ? Date.now() : null
  );
  // Falls back to showing the legacy intro card when auto-start fails so the
  // user still has a manual retry button.
  const [autoStartFailed, setAutoStartFailed] = useState(false);

  const onCreateFlowStarted = useCallback(() => {
    markPersonalOnboardingInProgress();
    setOnboardingInProgress(true);
    setAutoStartFailed(false);
    setCreateFlowStartedAt(Date.now());
  }, []);

  const onCreateFlowFailed = useCallback(() => {
    clearPersonalOnboardingInProgress();
    setOnboardingInProgress(false);
    setAutoStartFailed(true);
    setCreateFlowStartedAt(null);
  }, []);

  if (billingQuery.isLoading) {
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
  const mode: ClawOnboardingMode =
    createFlowStartedAt !== null || !hasActiveInstance || onboardingInProgress
      ? 'create-first'
      : 'post-provisioning';

  // Show identity (not the intro card) as the first screen whenever the
  // personal create-first wizard is shown — including refreshes during an
  // in-progress session. Falls back to the legacy intro card only if
  // auto-start has failed, so the user still has a manual retry button.
  const skipCreateInstanceStep = mode === 'create-first' && !autoStartFailed;

  // Only auto-kick the provisioning mutation on fresh entries — never on a
  // refresh where provisioning was already triggered in a previous session.
  // The onboarding-in-progress marker tells us that case.
  const autoProvisionOnMount =
    mode === 'create-first' && !autoStartFailed && !onboardingInProgress && !hasActiveInstance;

  return (
    <ClawNewLoader
      mode={mode}
      createFlowStartedAt={createFlowStartedAt}
      billingUpdatedAt={billingQuery.dataUpdatedAt}
      skipCreateInstanceStep={skipCreateInstanceStep}
      autoProvisionOnMount={autoProvisionOnMount}
      onCreateFlowStarted={onCreateFlowStarted}
      onCreateFlowFailed={onCreateFlowFailed}
    />
  );
}
