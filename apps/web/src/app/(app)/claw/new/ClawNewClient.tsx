'use client';

import { useCallback, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useKiloClawStatus } from '@/hooks/useKiloClaw';
import { useTRPC } from '@/lib/trpc/utils';
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
  onCreateFlowStarted,
  setupFailed,
  onCreateFlowFailed,
}: {
  mode: ClawOnboardingMode;
  createFlowStartedAt: number | null;
  setupFailed: boolean;
  billingUpdatedAt: number;
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
        setupFailed={setupFailed}
        onCreateFlowStarted={onCreateFlowStarted}
        onCreateFlowFailed={onCreateFlowFailed}
      />
    );
  }

  const statusQueryForBoundary = setupFailed
    ? {
        data: statusQuery.data,
        isLoading: false,
        error: null,
      }
    : statusQuery.error || statusQuery.dataUpdatedAt >= billingUpdatedAt
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
      setupFailed={setupFailed}
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
  const [createFlowStartedAt, setCreateFlowStartedAt] = useState<number | null>(null);
  const [setupFailed, setSetupFailed] = useState(false);
  const onCreateFlowStarted = useCallback(() => {
    setSetupFailed(false);
    setCreateFlowStartedAt(Date.now());
  }, []);
  const onCreateFlowFailed = useCallback(() => {
    setSetupFailed(true);
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

  if (!setupFailed && createFlowStartedAt === null && billingQuery.isFetching) {
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
    createFlowStartedAt !== null || !hasActiveInstance ? 'create-first' : 'post-provisioning';

  return (
    <ClawNewLoader
      mode={mode}
      createFlowStartedAt={createFlowStartedAt}
      setupFailed={setupFailed}
      billingUpdatedAt={billingQuery.dataUpdatedAt}
      onCreateFlowStarted={onCreateFlowStarted}
      onCreateFlowFailed={onCreateFlowFailed}
    />
  );
}
