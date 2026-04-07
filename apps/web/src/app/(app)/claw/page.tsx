'use client';

import { useCallback, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { useKiloClawStatus } from '@/hooks/useKiloClaw';
import { ClawDashboard, withStatusQueryBoundary } from './components';
import { WelcomePage } from './components/billing/WelcomePage';

const ClawDashboardWithBoundary = withStatusQueryBoundary(ClawDashboard);

/**
 * Inner component that owns the KiloClaw worker status polling.
 * Extracted so the hook only runs when the user actually has access
 * (new users on the WelcomePage don't have an instance to poll).
 */
function ClawDashboardLoader({
  isNewSetup,
  onNewSetupChange,
}: {
  isNewSetup: boolean;
  onNewSetupChange: (v: boolean) => void;
}) {
  const statusQuery = useKiloClawStatus();
  return (
    <ClawDashboardWithBoundary
      statusQuery={statusQuery}
      isNewSetup={isNewSetup}
      onNewSetupChange={onNewSetupChange}
    />
  );
}

export default function ClawPage() {
  const trpc = useTRPC();
  const billingQuery = useQuery(trpc.kiloclaw.getBillingStatus.queryOptions());
  const [isNewSetup, setIsNewSetup] = useState(false);
  const onNewSetupChange = useCallback((v: boolean) => setIsNewSetup(v), []);

  if (billingQuery.isLoading) {
    return (
      <div
        className="container m-auto flex w-full max-w-[1140px] items-center justify-center p-4 md:p-6"
        style={{ minHeight: '50vh' }}
      >
        <Loader2 className="text-muted-foreground h-8 w-8 animate-spin" />
      </div>
    );
  }

  // Treat billing fetch errors as a blocked state so transient failures
  // never accidentally expose the dashboard to suspended/expired users.
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

  // Brand-new user with no access and no instance (never provisioned).
  // Expired earlybird/trial users must NOT land here even if they never
  // provisioned; they proceed to ClawDashboard where AccessLockedDialog
  // shows the appropriate locked state.
  const billing = billingQuery.data;
  const isNewUser =
    billing &&
    !billing.hasAccess &&
    billing.instance === null &&
    !billing.earlybird &&
    !billing.trial?.expired;
  if (isNewUser) {
    // Trial-eligible users go straight to the dashboard which shows
    // CreateInstanceCard. Provisioning auto-creates the trial via
    // ensureProvisionAccess — no explicit "start trial" action needed.
    if (billing.trialEligible) {
      return (
        <ClawDashboard
          status={undefined}
          isNewSetup={isNewSetup}
          onNewSetupChange={onNewSetupChange}
        />
      );
    }
    // Non-trial-eligible new users (e.g. canceled subscription, no
    // instance) see the plan-selection page.
    return (
      <div className="container m-auto flex w-full max-w-[1140px] flex-col gap-6 p-4 md:p-6">
        <WelcomePage />
      </div>
    );
  }

  // Only poll the KiloClaw worker when the user has an instance row.
  // The kiloclaw_instances row is created during provisioning and never
  // deleted (destroyed instances keep the row with destroyed_at set), so
  // billing.instance is null only for users who have never provisioned.
  // Those users get ClawDashboard with no status, which renders
  // CreateInstanceCard.
  if (billing?.instance) {
    return <ClawDashboardLoader isNewSetup={isNewSetup} onNewSetupChange={onNewSetupChange} />;
  }

  return (
    <ClawDashboard status={undefined} isNewSetup={isNewSetup} onNewSetupChange={onNewSetupChange} />
  );
}
