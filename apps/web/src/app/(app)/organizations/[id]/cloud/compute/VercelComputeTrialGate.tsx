'use client';

import { AlertTriangle, Loader2, Lock } from 'lucide-react';
import { useOrganizationTrialStatus } from '@/app/api/organizations/hooks';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { VercelComputeSettings } from './VercelComputeSettings';

const ACCESS_NOTICES = {
  loading: {
    title: 'Checking Vercel compute access',
    description: "Checking this organization's subscription and trial status.",
  },
  error: {
    title: 'Vercel compute access could not be verified',
    description:
      "Vercel settings are unavailable until this organization's subscription and trial status can be verified.",
  },
  trial_expired_hard: {
    title: 'Vercel compute is locked',
    description:
      "This organization's trial has expired. Upgrade the organization to restore access to Vercel compute settings.",
  },
};

export function VercelComputeTrialGate({ organizationId }: { organizationId: string }) {
  const trialStatus = useOrganizationTrialStatus(organizationId);
  if (
    trialStatus !== 'loading' &&
    trialStatus !== 'error' &&
    trialStatus !== 'trial_expired_hard'
  ) {
    return <VercelComputeSettings organizationId={organizationId} />;
  }

  const notice = ACCESS_NOTICES[trialStatus];
  return (
    <section aria-label="Vercel compute" className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
      <Alert
        variant={trialStatus === 'error' ? 'destructive' : 'default'}
        role={trialStatus === 'error' ? 'alert' : 'status'}
      >
        {trialStatus === 'loading' ? (
          <Loader2 className="animate-spin" aria-hidden="true" />
        ) : trialStatus === 'error' ? (
          <AlertTriangle aria-hidden="true" />
        ) : (
          <Lock aria-hidden="true" />
        )}
        <AlertTitle className="line-clamp-none">{notice.title}</AlertTitle>
        <AlertDescription>
          <p>{notice.description}</p>
          <p>On-prem compute management and revocation remain available above.</p>
        </AlertDescription>
      </Alert>
    </section>
  );
}
