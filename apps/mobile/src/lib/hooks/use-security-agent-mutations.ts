import { isPersonalSecurityScope } from '@kilocode/app-shared/security-agent';
import { hashKey, useMutation, useQueryClient } from '@tanstack/react-query';

import { i18n } from '@/i18n';
import { announcingToast } from '@/lib/a11y/announcing-toast';
import {
  isLatestMutationGeneration,
  nextMutationGeneration,
} from '@/lib/hooks/mutation-generations';
import { trackSecurityAgentCommand } from '@/lib/hooks/use-security-agent-commands';
import { useHoistedOperationKey } from '@/lib/operation-key';
import { useMutationOutbox } from '@/lib/persist/use-mutation-outbox';
import { reconcileFirstPage } from '@/lib/query/infinite-retention';
import { scheduleCacheMaintenance } from '@/lib/query/schedule-cache-maintenance';
import {
  type FlattenedSecurityAgentConfig,
  type SecurityAgentConfig,
  type SecurityAgentConfigPatch,
} from '@/lib/security-agent';
import {
  isSecuritySyncInProgress,
  mapSecuritySyncOperationError,
  securityRetainsOperationKey,
  securitySyncIntentFingerprint,
} from '@/lib/security-agent-ledger';
import { trpcClient, useTRPC } from '@/lib/trpc';
import { pick } from '@/lib/utils';

// Split out of use-security-agent.ts (mutations only) to stay under the
// 300-line file limit — these are the write-side hooks, kept alongside the
// query-key helper they share.
function useSecurityAgentConfigQueryKey(scope: string) {
  const trpc = useTRPC();
  return isPersonalSecurityScope(scope)
    ? trpc.securityAgent.getConfig.queryKey()
    : trpc.organizations.securityAgent.getConfig.queryKey({ organizationId: scope });
}

export function useSaveSecurityAgentConfig(
  scope: string,
  { announceSaved = true }: Readonly<{ announceSaved?: boolean }> = {}
) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const configQueryKey = useSecurityAgentConfigQueryKey(scope);

  // onError policy: roll back the onMutate snapshot (latest generation only)
  // and toast error.message.
  return useMutation({
    // Reachability is the save's outcome, not a precondition: the default
    // `networkMode: 'online'` pauses the mutation while the connectivity
    // manager reports the device offline, so the request is never sent, the
    // caller's `mutateAsync` never settles (the header keeps Save disabled
    // with its spinner up and the draft stays dirty, with no failure surface),
    // and the queued save lands silently once the connection returns.
    // Attempting the request instead lets it fail through the normal path:
    // onError restores the snapshot and toasts the failure, so Save returns to
    // an enabled retry state with the draft intact.
    networkMode: 'always',
    // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
    mutationFn: (patch: Omit<SecurityAgentConfigPatch, 'expectedRevision'>) => {
      // The server rejects a save whose revision is stale, so send the revision
      // the last getConfig returned. `null` means the client saw no config yet.
      const current = queryClient.getQueryData<SecurityAgentConfig>(configQueryKey);
      const expectedRevision = current?.configRevision ?? null;
      return isPersonalSecurityScope(scope)
        ? trpcClient.securityAgent.saveConfig.mutate({ ...patch, expectedRevision })
        : trpcClient.organizations.securityAgent.saveConfig.mutate({
            organizationId: scope,
            ...patch,
            expectedRevision,
          });
    },
    onMutate: async patch => {
      await queryClient.cancelQueries({ queryKey: configQueryKey });
      const generation = nextMutationGeneration(hashKey(configQueryKey));
      const previous = queryClient.getQueryData<FlattenedSecurityAgentConfig>(configQueryKey);
      queryClient.setQueryData<FlattenedSecurityAgentConfig>(configQueryKey, old =>
        old ? { ...old, ...patch } : old
      );
      return { previous, patch, generation };
    },
    onError: (error, _patch, context) => {
      if (
        context?.previous &&
        isLatestMutationGeneration(hashKey(configQueryKey), context.generation)
      ) {
        const keys = Object.keys(context.patch) as (keyof SecurityAgentConfig)[];
        const restoredFields = pick(context.previous, keys);
        queryClient.setQueryData<FlattenedSecurityAgentConfig>(configQueryKey, old =>
          old ? { ...old, ...restoredFields } : old
        );
      }
      announcingToast.error(error.message);
    },
    onSuccess: result => {
      // Saving pops the settings screen, and the screen it returns to can fail
      // to load on a flaky connection. Confirming the write here keeps a
      // persisted save from reading as a lost one wherever the navigation lands.
      // A screen with a more specific outcome of its own (Automation's queued
      // count) turns this off and announces in its place, so one save is one
      // confirmation.
      if (announceSaved) {
        announcingToast.success(i18n.t('securityAgent.settingsSave.saved'));
      }
      if (result.existingRemediationCommandId) {
        trackSecurityAgentCommand(queryClient, scope, result.existingRemediationCommandId);
      }
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: configQueryKey });
      if (isPersonalSecurityScope(scope)) {
        await queryClient.invalidateQueries({
          queryKey: trpc.securityAgent.getDashboardStats.queryKey(),
        });
        scheduleCacheMaintenance(() => {
          void reconcileFirstPage(queryClient, trpc.securityAgent.listFindings.queryKey());
        });
        return;
      }
      await queryClient.invalidateQueries({
        queryKey: trpc.organizations.securityAgent.getDashboardStats.queryKey({
          organizationId: scope,
        }),
      });
      scheduleCacheMaintenance(() => {
        void reconcileFirstPage(
          queryClient,
          trpc.organizations.securityAgent.listFindings.queryKey({ organizationId: scope })
        );
      });
    },
    // Serialize a save against a toggle on the same config so the network
    // calls land in order; the generation guard above orders the rollbacks.
    scope: { id: `security-agent-config:${scope}` },
  });
}

export function useSetSecurityAgentEnabled(scope: string) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const configQueryKey = useSecurityAgentConfigQueryKey(scope);

  // onError policy: roll back the onMutate snapshot (latest generation only)
  // and toast error.message.
  return useMutation({
    // Same reason as the config save above: pausing while the connectivity
    // manager reports offline keeps the switch in its optimistic position with
    // no rollback and no toast, and the queued toggle lands silently after
    // reconnecting. Attempting the request fails through the normal path.
    networkMode: 'always',
    // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
    mutationFn: (vars: Parameters<typeof trpcClient.securityAgent.setEnabled.mutate>[0]) =>
      isPersonalSecurityScope(scope)
        ? trpcClient.securityAgent.setEnabled.mutate(vars)
        : trpcClient.organizations.securityAgent.setEnabled.mutate({
            organizationId: scope,
            ...vars,
          }),
    onMutate: async vars => {
      await queryClient.cancelQueries({ queryKey: configQueryKey });
      const generation = nextMutationGeneration(hashKey(configQueryKey));
      const previous = queryClient.getQueryData<SecurityAgentConfig>(configQueryKey);
      queryClient.setQueryData<SecurityAgentConfig>(configQueryKey, old =>
        old ? { ...old, isEnabled: vars.isEnabled } : old
      );
      return { previous, generation };
    },
    onError: (error, _vars, context) => {
      if (
        context?.previous &&
        isLatestMutationGeneration(hashKey(configQueryKey), context.generation)
      ) {
        const previous = context.previous;
        queryClient.setQueryData<SecurityAgentConfig>(configQueryKey, old =>
          old ? { ...old, isEnabled: previous.isEnabled } : old
        );
      }
      announcingToast.error(error.message);
    },
    onSuccess: result => {
      if ('initialSyncAdmissionFailed' in result && result.initialSyncAdmissionFailed) {
        announcingToast.error(i18n.t('securityAgent.initialSyncAdmissionFailed'));
      } else if ('initialSync' in result && result.initialSync) {
        trackSecurityAgentCommand(queryClient, scope, result.initialSync.commandId);
      }
    },
    onSettled: async () => {
      if (isPersonalSecurityScope(scope)) {
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: trpc.securityAgent.getPermissionStatus.queryKey(),
          }),
          queryClient.invalidateQueries({ queryKey: configQueryKey }),
          queryClient.invalidateQueries({
            queryKey: trpc.securityAgent.getRepositories.queryKey(),
          }),
        ]);
        return;
      }
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: trpc.organizations.securityAgent.getPermissionStatus.queryKey({
            organizationId: scope,
          }),
        }),
        queryClient.invalidateQueries({ queryKey: configQueryKey }),
        queryClient.invalidateQueries({
          queryKey: trpc.organizations.securityAgent.getRepositories.queryKey({
            organizationId: scope,
          }),
        }),
      ]);
    },
    // Serialize a toggle against a save on the same config so the network
    // calls land in order; the generation guard above orders the rollbacks.
    scope: { id: `security-agent-config:${scope}` },
  });
}

export function useTriggerSecuritySync(scope: string) {
  const queryClient = useQueryClient();
  const { getKey, rotateKey } = useHoistedOperationKey();
  // P1-E-40c: Security sync is reconcile-first — persist the row so a crash
  // mid-flight surfaces a card on relaunch instead of auto-replaying.
  const { writeReconcileFirst, remove: removeOutboxRow, whenLoaded } = useMutationOutbox();

  return useMutation({
    // A manual sync is a tap with a visible pending state, not a background
    // job: pausing it while the connectivity manager reports offline leaves the
    // dashboard's sync control spinning with no outcome until the connection
    // returns. Attempting the request fails through the normal path, bounded by
    // the transport deadline, and the reconcile-first row written above records
    // the ambiguous outcome, so a relaunch offers the reconcile retry instead
    // of blindly re-POSTing.
    networkMode: 'always',
    mutationFn: async (
      vars: Parameters<typeof trpcClient.securityAgent.triggerSync.mutate>[0] = {}
    ) => {
      const fingerprint = securitySyncIntentFingerprint(scope, vars.repoFullName);
      // Gate on the outbox load first: a sync that races the launch load would
      // read empty rows and write a fresh key over a crash row, dropping the
      // stored reconcile key.
      // A failed outbox read reads as no stored rows, so refuse instead of
      // writing a fresh key over a crash row the server may already hold.
      if (!(await whenLoaded())) {
        throw new Error(i18n.t('securityAgent.mutations.couldNotReadPendingSyncs'));
      }
      // Persist the reconcile-first row BEFORE the POST and resolve the row's
      // own operationKey: a stored row keeps its key, so the wire never POSTs
      // a fresh in-memory key over a crash row. The row carries the scope so
      // the dashboard shows only its own rows.
      const operationKey = await writeReconcileFirst({
        operationKey: vars.operationKey ?? getKey(fingerprint),
        fingerprint,
        scope,
        input: vars,
      });
      try {
        const result = isPersonalSecurityScope(scope)
          ? await trpcClient.securityAgent.triggerSync.mutate({ ...vars, operationKey })
          : await trpcClient.organizations.securityAgent.triggerSync.mutate({
              organizationId: scope,
              ...vars,
              operationKey,
            });
        rotateKey();
        await removeOutboxRow(fingerprint);
        return result;
      } catch (error) {
        if (!securityRetainsOperationKey(error)) {
          rotateKey();
          await removeOutboxRow(fingerprint);
        }
        // A retryable failure whose key survives is ambiguous: the server may
        // have accepted the command, so a relaunch must reconcile, not re-POST.
        // A settled intent keeps no row — its key can never be replayed.
        throw mapSecuritySyncOperationError(error);
      }
    },
    onError: error => {
      // The in-progress conflict is the sync already running, not a failed
      // action: the dashboard shows it as progress, so an error toast would
      // contradict the control the reader is looking at.
      if (isSecuritySyncInProgress(error)) {
        return;
      }
      announcingToast.error(error.message);
    },
    onSuccess: result => {
      if (result.commandId) {
        trackSecurityAgentCommand(queryClient, scope, result.commandId);
      }
    },
  });
}

export function useTrackSecurityAgentInteraction(scope: string) {
  return useMutation({
    // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
    mutationFn: (vars: Parameters<typeof trpcClient.securityAgent.trackUiInteraction.mutate>[0]) =>
      isPersonalSecurityScope(scope)
        ? trpcClient.securityAgent.trackUiInteraction.mutate(vars)
        : trpcClient.organizations.securityAgent.trackUiInteraction.mutate({
            organizationId: scope,
            ...vars,
          }),
    // Intentionally no onError handler: this is fire-and-forget telemetry that
    // pings on nav/tab/toggle. A failure must never surface a user-facing toast —
    // it would spam errors and stack on top of real mutation errors. React Query
    // captures the rejection internally; we deliberately don't act on it.
  });
}
