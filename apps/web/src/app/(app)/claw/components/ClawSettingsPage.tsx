'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Settings } from 'lucide-react';
import { useRouter } from 'next/navigation';
import type { KiloClawDashboardStatus } from '@/lib/kiloclaw/types';
import { useKiloClawStatus, useKiloClawMutations } from '@/hooks/useKiloClaw';
import { useOrgKiloClawStatus, useOrgKiloClawMutations } from '@/hooks/useOrgKiloClaw';
import { ClawContextProvider, useClawContext } from './ClawContext';
import { SettingsTab } from './SettingsTab';
import { BillingWrapper } from './billing/BillingWrapper';
import { SetPageTitle } from '@/components/SetPageTitle';
import { Card, CardContent } from '@/components/ui/card';

/**
 * Standalone settings page content. Sets up the mutation hooks, dirty-secret
 * tracking, and redeploy/upgrade callbacks that SettingsTab needs.
 */
function ClawSettingsInner({ status }: { status: KiloClawDashboardStatus }) {
  const { organizationId } = useClawContext();

  const personalMutations = useKiloClawMutations();
  const orgMutations = useOrgKiloClawMutations(organizationId ?? '');
  const mutations = organizationId ? orgMutations : personalMutations;

  const [dirtySecrets, setDirtySecrets] = useState<Set<string>>(new Set());
  const onSecretsChanged = useCallback((entryId: string) => {
    setDirtySecrets(prev => new Set([...prev, entryId]));
  }, []);

  const onRedeploySuccess = useCallback(() => {
    setDirtySecrets(new Set());
  }, []);

  const onRedeploy = useCallback(() => {
    mutations.restartMachine.mutate(undefined, {
      onSuccess: () => {
        toast.success('Redeploying');
        onRedeploySuccess();
      },
      onError: err => {
        toast.error(err.message, { duration: 10000 });
      },
    });
  }, [mutations.restartMachine, onRedeploySuccess]);

  const onUpgrade = useCallback(() => {
    mutations.restartMachine.mutate(
      { imageTag: 'latest' },
      {
        onSuccess: () => {
          toast.success('Upgrading to latest image');
          onRedeploySuccess();
        },
        onError: err => {
          toast.error(err.message, { duration: 10000 });
        },
      }
    );
  }, [mutations.restartMachine, onRedeploySuccess]);

  const onRequestUpgrade = useCallback(() => {
    onUpgrade();
  }, [onUpgrade]);

  return (
    <SettingsTab
      status={status}
      mutations={mutations}
      onSecretsChanged={onSecretsChanged}
      dirtySecrets={dirtySecrets}
      onRedeploy={onRedeploy}
      onUpgrade={onUpgrade}
      onRequestUpgrade={onRequestUpgrade}
    />
  );
}

/**
 * Wrapper that polls status and handles loading/error/no-instance states
 * before rendering the settings content.
 */
function ClawSettingsWithStatus({ organizationId }: { organizationId?: string }) {
  const router = useRouter();
  const personalStatus = useKiloClawStatus();
  const orgStatus = useOrgKiloClawStatus(organizationId ?? '');
  const { data: status, isLoading, error } = organizationId ? orgStatus : personalStatus;

  const clawUrl = organizationId ? `/organizations/${organizationId}/claw` : '/claw';

  // Redirect to main KiloClaw page when there is no instance — it has the
  // onboarding/provisioning flow that guides the user through setup.
  const shouldRedirect = !isLoading && !error && (!status || status.status === null);
  useEffect(() => {
    if (shouldRedirect) {
      router.replace(clawUrl);
    }
  }, [shouldRedirect, clawUrl, router]);

  if (isLoading || shouldRedirect) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <p className="text-muted-foreground">Loading…</p>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <p className="text-destructive text-sm">
            Failed to load status: {error instanceof Error ? error.message : 'Unknown error'}
          </p>
        </CardContent>
      </Card>
    );
  }

  // status is guaranteed non-null with a non-null .status after the checks above
  if (!status || status.status === null) return null;
  const settingsContent = <ClawSettingsInner status={status} />;

  // Personal context uses BillingWrapper for access-lock dialogs/banners.
  if (!organizationId) {
    return <BillingWrapper>{settingsContent}</BillingWrapper>;
  }

  return settingsContent;
}

export function ClawSettingsPage({ organizationId }: { organizationId?: string }) {
  return (
    <ClawContextProvider organizationId={organizationId}>
      <div className="container m-auto flex w-full max-w-[1140px] flex-col gap-6 p-4 md:p-6">
        <SetPageTitle
          title="Settings"
          icon={<Settings className="text-muted-foreground h-4 w-4" />}
        />
        <ClawSettingsWithStatus organizationId={organizationId} />
      </div>
    </ClawContextProvider>
  );
}
