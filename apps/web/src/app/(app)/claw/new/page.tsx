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
  onCreateFlowStarted,
}: {
  mode: ClawOnboardingMode;
  onCreateFlowStarted: () => void;
}) {
  const statusQuery = useKiloClawStatus();
  return (
    <ClawOnboardingWithBoundary
      statusQuery={statusQuery}
      mode={mode}
      onCreateFlowStarted={onCreateFlowStarted}
    />
  );
}

export default function ClawNewPage() {
  const trpc = useTRPC();
  const billingQuery = useQuery(trpc.kiloclaw.getBillingStatus.queryOptions());
  const [createFlowStarted, setCreateFlowStarted] = useState(false);
  const onCreateFlowStarted = useCallback(() => setCreateFlowStarted(true), []);

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
    createFlowStarted || !hasActiveInstance ? 'create-first' : 'post-provisioning';

  if (hasActiveInstance) {
    return <ClawNewLoader mode={mode} onCreateFlowStarted={onCreateFlowStarted} />;
  }

  return (
    <ClawOnboardingFlow
      status={undefined}
      mode="create-first"
      onCreateFlowStarted={onCreateFlowStarted}
    />
  );
}
