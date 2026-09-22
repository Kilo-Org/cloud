'use client';

import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import type { DrawerStackHelpers } from '@/components/drawer';
import {
  organizationAlertClientDefinitions,
  organizationAlertDefinition,
} from '@/components/organizations/alerts/registry.client';
import type { OrganizationAlertLifecycleActions } from '@/components/organizations/alerts/types';
import {
  useInvalidateOrganizationAlerts,
  useOrganizationAlertsQuery,
} from '@/components/organizations/alerts/useOrganizationAlerts';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { useUser } from '@/hooks/useUser';
import {
  MONTHLY_SPENDING_ALERT_TYPE,
  OrganizationAlertDefinitionSchema,
  type OrganizationAlertType,
} from '@/lib/organizations/alerts/organization-alerts';
import { useTRPC } from '@/lib/trpc/utils';
import type { OrganizationAlertsDrawerRef } from './types';

/**
 * Shared shell for creating and editing an alert. It owns the type dropdown, the
 * router mutations, cache invalidation, and lifecycle actions; each alert type
 * owns its own fields and validation through the registry.
 */
export function AlertEditorPanel({
  organizationId,
  canExpand,
  entry,
  helpers,
}: {
  organizationId: string;
  /** Whether the organization may still create, enable, or expand alerts. */
  canExpand: boolean;
  entry: OrganizationAlertsDrawerRef;
  helpers: DrawerStackHelpers<OrganizationAlertsDrawerRef>;
}) {
  const trpc = useTRPC();
  const invalidate = useInvalidateOrganizationAlerts();
  const userQuery = useUser();
  const alertsQuery = useOrganizationAlertsQuery(organizationId);
  const [alertType, setAlertType] = useState<OrganizationAlertType>(MONTHLY_SPENDING_ALERT_TYPE);
  const [error, setError] = useState<string | null>(null);
  const createMutation = useMutation(trpc.organizations.alerts.create.mutationOptions());
  const updateMutation = useMutation(trpc.organizations.alerts.update.mutationOptions());
  const setEnabledMutation = useMutation(trpc.organizations.alerts.setEnabled.mutationOptions());
  const archiveMutation = useMutation(trpc.organizations.alerts.archive.mutationOptions());

  /**
   * Runs one mutation and refreshes the cached alerts either way. Refreshing on
   * failure is what makes a stale-version conflict recoverable: the panel picks
   * up the current configuration version so the same edit can be retried.
   */
  async function run(
    action: () => Promise<unknown>,
    outcome: { success: string; closeOnSuccess: boolean }
  ): Promise<void> {
    try {
      await action();
      setError(null);
      await invalidate();
      toast.success(outcome.success);
      if (outcome.closeOnSuccess) helpers.close();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'This alert could not be changed.');
      await invalidate();
    }
  }

  const alert =
    entry.type === 'alert-edit'
      ? alertsQuery.data?.pages
          .flatMap(page => page.alerts)
          .find(candidate => candidate.id === entry.alertId)
      : undefined;

  // Creating waits for the current user so the suggested recipient is part of the
  // editor's initial state rather than appearing after it has been filled in.
  if (entry.type === 'alert-edit' ? alertsQuery.isPending : userQuery.isPending) {
    return (
      <div className="grid gap-3 p-5" role="status" aria-busy="true">
        <span className="sr-only">Loading alert...</span>
        <Skeleton className="h-10" />
        <Skeleton className="h-40" />
      </div>
    );
  }

  // Persisted configuration is validated against the type's own schema rather
  // than trusted, which is also what keeps this shell free of per-type narrowing.
  const stored = alert
    ? OrganizationAlertDefinitionSchema.safeParse({
        type: alert.type,
        configuration: alert.configuration,
      })
    : undefined;

  const storedDefinition = stored && stored.success ? stored.data : undefined;
  if (entry.type === 'alert-edit' && !storedDefinition) {
    return (
      <p role="alert" className="type-body text-status-destructive p-5">
        This alert is no longer available. Close the drawer and reload the list.
      </p>
    );
  }

  const definition = organizationAlertDefinition(storedDefinition?.type ?? alertType);
  const Editor = definition.Editor;
  const lifecycle: OrganizationAlertLifecycleActions | null = alert
    ? {
        isEnabled: alert.status === 'enabled',
        isUpdatingEnabled: setEnabledMutation.isPending,
        onSetEnabled: enabled =>
          void run(
            () =>
              setEnabledMutation.mutateAsync({
                organizationId,
                alertId: alert.id,
                enabled,
                expectedConfigurationVersion: alert.configurationVersion,
              }),
            { success: enabled ? 'Alert enabled' : 'Alert disabled', closeOnSuccess: false }
          ),
        isArchiving: archiveMutation.isPending,
        onArchive: () =>
          run(() => archiveMutation.mutateAsync({ organizationId, alertId: alert.id }), {
            success: 'Alert archived',
            closeOnSuccess: true,
          }),
      }
    : null;

  return (
    <div className="flex min-h-full flex-col">
      {entry.type === 'alert-create' && (
        <div className="grid gap-1.5 border-b p-5">
          <Label htmlFor="alert-type">Alert type</Label>
          <Select
            value={definition.type}
            onValueChange={value => {
              const selected = organizationAlertClientDefinitions.find(
                candidate => candidate.type === value
              );
              if (!selected) return;
              setAlertType(selected.type);
              // The previous type's failure does not describe the new editor.
              setError(null);
            }}
          >
            <SelectTrigger id="alert-type" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="z-[70]">
              {organizationAlertClientDefinitions.map(candidate => (
                <SelectItem key={candidate.type} value={candidate.type}>
                  <candidate.Icon />
                  {candidate.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="type-label text-muted-foreground">{definition.description}</p>
        </div>
      )}

      <Editor
        // Remounts so switching type or reopening an alert starts from that
        // configuration instead of carrying the previous form state.
        key={`${definition.type}:${alert?.id ?? 'new'}`}
        context={{
          mode: alert ? 'edit' : 'create',
          organizationId,
          definition:
            storedDefinition ??
            definition.createInitialDefinition({
              suggestedRecipient: userQuery.data?.google_user_email ?? null,
            }),
          admittedRecipientCount: alert?.admittedRecipientCount ?? 0,
          canExpand,
        }}
        isSaving={createMutation.isPending || updateMutation.isPending}
        error={error}
        onCancel={helpers.close}
        lifecycle={lifecycle}
        onSave={input =>
          void run(
            () =>
              alert
                ? updateMutation.mutateAsync({
                    organizationId,
                    alertId: alert.id,
                    definition: input.definition,
                    expectedConfigurationVersion: alert.configurationVersion,
                    recipientDisclosureConfirmed: input.recipientDisclosureConfirmed,
                  })
                : createMutation.mutateAsync({
                    organizationId,
                    definition: input.definition,
                    enabled: true,
                    recipientDisclosureConfirmed: input.recipientDisclosureConfirmed,
                  }),
            { success: alert ? 'Alert saved' : 'Alert created', closeOnSuccess: true }
          )
        }
      />
    </div>
  );
}
