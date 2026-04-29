'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Settings } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { TRPCClientError } from '@trpc/client';
import type { KiloClawDashboardStatus } from '@/lib/kiloclaw/types';
import { useKiloClawStatus, useKiloClawMutations, useKiloClawMyPin } from '@/hooks/useKiloClaw';
import {
  useOrgKiloClawStatus,
  useOrgKiloClawMutations,
  useOrgKiloClawMyPin,
} from '@/hooks/useOrgKiloClaw';
import { ClawContextProvider, useClawContext } from './ClawContext';
import { ClawConfigServiceBanner } from './ClawConfigServiceBanner';
import { ClawInstanceOverview } from './ClawInstanceOverview';
import { SettingsTab } from './SettingsTab';
import { UpgradeKiloClawDialog } from './UpgradeKiloClawDialog';
import { BillingWrapper } from './billing/BillingWrapper';
import { SetPageTitle } from '@/components/SetPageTitle';
import { Card, CardContent } from '@/components/ui/card';

/**
 * Standalone settings page content. Sets up the mutation hooks, dirty-secret
 * tracking, and redeploy/upgrade callbacks that SettingsTab needs.
 */
function ClawSettingsInner({
  status,
  organizationName,
}: {
  status: KiloClawDashboardStatus;
  organizationName?: string;
}) {
  const { organizationId } = useClawContext();

  const personalMutations = useKiloClawMutations();
  const orgMutations = useOrgKiloClawMutations(organizationId ?? '');
  const mutations = organizationId ? orgMutations : personalMutations;

  // Pin state for the upgrade-confirmation dialog. Only the active
  // context queries (org vs personal); the inactive hook stays disabled
  // so we don't fire an org getMyPin with an empty organizationId.
  const personalPin = useKiloClawMyPin({ enabled: !organizationId });
  const orgPin = useOrgKiloClawMyPin(organizationId ?? '', {
    enabled: !!organizationId,
  });
  const pin = organizationId ? orgPin.data : personalPin.data;
  const pinnedImageTag = pin?.image_tag ?? null;

  const [dirtySecrets, setDirtySecrets] = useState<Set<string>>(new Set());
  const [confirmUpgrade, setConfirmUpgrade] = useState(false);
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

  const onRequestUpgrade = useCallback(() => {
    setConfirmUpgrade(true);
  }, []);

  const onConfirmUpgrade = useCallback(() => {
    // Only ack what was actually rendered to the user. If pinnedImageTag
    // is null (no warning shown), send false; the backend gate will
    // catch any pin that appeared between render and click and surface
    // PIN_EXISTS so the user can retry with fresh data.
    mutations.restartMachine.mutate(
      { imageTag: 'latest', acknowledgePinRemoval: !!pinnedImageTag },
      {
        onSuccess: () => {
          toast.success('Upgrading KiloClaw');
          setConfirmUpgrade(false);
          onRedeploySuccess();
        },
        onError: err => {
          if (
            err instanceof TRPCClientError &&
            err.data?.code === 'PRECONDITION_FAILED' &&
            err.message === 'PIN_EXISTS'
          ) {
            // Pin appeared between render and click. Refetch the active
            // context's pin query so the dialog re-renders with a warning
            // on the next click.
            if (organizationId) void orgPin.refetch();
            else void personalPin.refetch();
            toast.error(
              'A version pin was set on this instance. Review the warning and try again.',
              { duration: 10000 }
            );
            return;
          }
          toast.error(err.message, { duration: 10000 });
        },
      }
    );
  }, [
    mutations.restartMachine,
    onRedeploySuccess,
    pinnedImageTag,
    organizationId,
    orgPin,
    personalPin,
  ]);

  return (
    <>
      <ClawInstanceOverview
        status={status}
        onRedeploySuccess={onRedeploySuccess}
        onRequestUpgrade={onRequestUpgrade}
      />
      <SettingsTab
        status={status}
        mutations={mutations}
        onSecretsChanged={onSecretsChanged}
        dirtySecrets={dirtySecrets}
        onRedeploy={onRedeploy}
        onRequestUpgrade={onRequestUpgrade}
        organizationName={organizationName}
      />
      <UpgradeKiloClawDialog
        open={confirmUpgrade}
        onOpenChange={open => {
          if (mutations.restartMachine.isPending) return;
          setConfirmUpgrade(open);
        }}
        isPending={mutations.restartMachine.isPending}
        onConfirm={onConfirmUpgrade}
        pinnedImageTag={pinnedImageTag}
      />
    </>
  );
}

/**
 * Wrapper that polls status and handles loading/error/no-instance states
 * before rendering the settings content.
 */
function ClawSettingsWithStatus({
  organizationId,
  organizationName,
}: {
  organizationId?: string;
  organizationName?: string;
}) {
  const router = useRouter();
  const personalStatus = useKiloClawStatus();
  const orgStatus = useOrgKiloClawStatus(organizationId);
  const { data: status, isLoading, error } = organizationId ? orgStatus : personalStatus;

  const clawUrl = organizationId ? `/organizations/${organizationId}/claw/new` : '/claw/new';

  // Redirect to setup when there is no instance.
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
  const settingsContent = (
    <div className="flex flex-col gap-6">
      <ClawConfigServiceBanner status={status} />
      <ClawSettingsInner status={status} organizationName={organizationName} />
    </div>
  );

  // Personal context uses BillingWrapper for access-lock dialogs/banners.
  if (!organizationId) {
    return <BillingWrapper>{settingsContent}</BillingWrapper>;
  }

  return settingsContent;
}

export function ClawSettingsPage({
  organizationId,
  organizationName,
}: {
  organizationId?: string;
  organizationName?: string;
}) {
  return (
    <ClawContextProvider organizationId={organizationId}>
      <div className="container m-auto flex w-full max-w-[1140px] flex-col gap-6 p-4 md:p-6">
        <SetPageTitle
          title="Settings"
          icon={<Settings className="text-muted-foreground h-4 w-4" />}
        />
        <ClawSettingsWithStatus
          organizationId={organizationId}
          organizationName={organizationName}
        />
      </div>
    </ClawContextProvider>
  );
}
