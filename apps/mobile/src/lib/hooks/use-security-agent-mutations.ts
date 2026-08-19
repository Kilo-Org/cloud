import { isPersonalSecurityScope } from '@kilocode/app-shared/security-agent';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { announcingToast } from '@/lib/a11y/announcing-toast';
import { trackSecurityAgentCommand } from '@/lib/hooks/use-security-agent-commands';
import {
  isOperationInProgress,
  OPERATION_KEY_REUSE_MISMATCH_MESSAGE,
  useHoistedOperationKey,
} from '@/lib/operation-key';
import { useMutationOutbox } from '@/lib/persist/use-mutation-outbox';
import { classifyPrReviewMutationError } from '@/lib/pr-review/classify-pr-review-query-state';
import { reconcileFirstPage, scheduleCacheMaintenance } from '@/lib/query/infinite-retention';
import {
  type FlattenedSecurityAgentConfig,
  type SecurityAgentConfig,
  type SecurityAgentConfigPatch,
} from '@/lib/security-agent';
import { trpcClient, useTRPC } from '@/lib/trpc';
import { pick } from '@/lib/utils';

// P1-A-08e ledger markers (server contract, mirrored from shared-handlers.ts).
// The raw markers are shared in `@/lib/operation-key`; the server sends
// user-facing copy for every other ledger outcome.
const SECURITY_OPERATION_REPLAY_FAILED_MESSAGE = 'This action did not complete. Please try again.';
// Ambiguous transport outcome: the Worker may have accepted the command, so the
// server reconciles a same-key retry instead of re-submitting blind.
const SECURITY_AMBIGUOUS_MESSAGE = "Couldn't confirm — check the security review before retrying.";
// Confirmed outcome whose settle failed: a same-key retry re-records it.
const SECURITY_LEDGER_SETTLE_FAILED_MESSAGE =
  'The action completed, but we could not record the result. Please try again.';
// The ambiguous outcome could not be recorded as reconcile-pending, so the
// same-key retry guarantee does not hold; the next submit needs a fresh key.
const SECURITY_LEDGER_PERSISTENCE_FAILED_MESSAGE =
  'We could not record this action. Please try again later.';

// The manual-sync Worker URL or internal secret is unset server-side, so no
// resubmit can succeed until the deployment is reconfigured.
export const SECURITY_SERVICE_NOT_CONFIGURED_MESSAGE = 'Security service is not configured';

/** Surface copy for the missing-configuration state (dismiss sheet). */
export const SECURITY_CONFIGURATION_COPY =
  'Security service is not configured. Resubmitting cannot succeed until this is fixed.';

/**
 * Card copy for a reconcile-first sync row: a crash mid-sync left the outcome
 * uncertain, so the card offers a same-key reconcile retry instead of a blind
 * re-POST.
 */
export const SECURITY_SYNC_RECONCILE_COPY =
  'A sync may not have completed. Retry to reconcile it, or discard.';

/** True when the error is the server's missing-Worker-configuration rejection. */
export function isSecurityConfigurationError(error: unknown): boolean {
  return error instanceof Error && error.message === SECURITY_SERVICE_NOT_CONFIGURED_MESSAGE;
}

/** In-progress surface copy: reads like the existing retryable toasts. */
const SECURITY_SYNC_IN_PROGRESS_COPY = 'A security sync is already in progress. Please try again.';
/** Same shape, right noun for the dismiss sheet. */
const SECURITY_DISMISS_IN_PROGRESS_COPY =
  'This dismissal is already in progress. Please try again.';

/**
 * True when the mutation may be retried under the SAME operation key. Also
 * used for finding dismissal, which shares the ledger markers.
 */
export function isSecuritySyncRetryable(error: unknown): boolean {
  if (error instanceof Error) {
    if (isSecurityConfigurationError(error)) {
      return false;
    }
    if (error.message === OPERATION_KEY_REUSE_MISMATCH_MESSAGE) {
      return false;
    }
    if (error.message === SECURITY_OPERATION_REPLAY_FAILED_MESSAGE) {
      return false;
    }
    if (error.message === SECURITY_LEDGER_PERSISTENCE_FAILED_MESSAGE) {
      return false;
    }
    if (
      error.message === SECURITY_AMBIGUOUS_MESSAGE ||
      error.message === SECURITY_LEDGER_SETTLE_FAILED_MESSAGE
    ) {
      return true;
    }
  }
  return classifyPrReviewMutationError(error).kind === 'retryable';
}

function mapOperationInProgress(error: unknown, copy: string) {
  return isOperationInProgress(error) ? new Error(copy) : error;
}

/** Maps the raw in-progress marker onto retryable sync copy; others pass through. */
export function mapSecuritySyncOperationError(error: unknown) {
  return mapOperationInProgress(error, SECURITY_SYNC_IN_PROGRESS_COPY);
}

/** Same marker, dismissal copy: the dismiss sheet must not talk about a sync. */
export function mapSecurityDismissOperationError(error: unknown) {
  return mapOperationInProgress(error, SECURITY_DISMISS_IN_PROGRESS_COPY);
}

/** Intent fingerprint for a manual sync: a changed scope or repo is a new intent. */
export function securitySyncIntentFingerprint(scope: string, repoFullName?: string): string {
  return JSON.stringify({ resource: [scope], repoFullName });
}

// Split out of use-security-agent.ts (mutations only) to stay under the
// 300-line file limit — these are the write-side hooks, kept alongside the
// query-key helper they share.
function useSecurityAgentConfigQueryKey(scope: string) {
  const trpc = useTRPC();
  return isPersonalSecurityScope(scope)
    ? trpc.securityAgent.getConfig.queryKey()
    : trpc.organizations.securityAgent.getConfig.queryKey({ organizationId: scope });
}

export function useSaveSecurityAgentConfig(scope: string) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const configQueryKey = useSecurityAgentConfigQueryKey(scope);

  return useMutation({
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
      const previous = queryClient.getQueryData<FlattenedSecurityAgentConfig>(configQueryKey);
      queryClient.setQueryData<FlattenedSecurityAgentConfig>(configQueryKey, old =>
        old ? { ...old, ...patch } : old
      );
      return { previous, patch };
    },
    onError: (error, _patch, context) => {
      if (context?.previous) {
        const keys = Object.keys(context.patch) as (keyof SecurityAgentConfig)[];
        const restoredFields = pick(context.previous, keys);
        queryClient.setQueryData<FlattenedSecurityAgentConfig>(configQueryKey, old =>
          old ? { ...old, ...restoredFields } : old
        );
      }
      announcingToast.error(error.message);
    },
    onSuccess: result => {
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
          reconcileFirstPage(queryClient, trpc.securityAgent.listFindings.queryKey());
        });
        return;
      }
      await queryClient.invalidateQueries({
        queryKey: trpc.organizations.securityAgent.getDashboardStats.queryKey({
          organizationId: scope,
        }),
      });
      scheduleCacheMaintenance(() => {
        reconcileFirstPage(
          queryClient,
          trpc.organizations.securityAgent.listFindings.queryKey({ organizationId: scope })
        );
      });
    },
  });
}

export function useSetSecurityAgentEnabled(scope: string) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const configQueryKey = useSecurityAgentConfigQueryKey(scope);

  return useMutation({
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
      const previous = queryClient.getQueryData<SecurityAgentConfig>(configQueryKey);
      queryClient.setQueryData<SecurityAgentConfig>(configQueryKey, old =>
        old ? { ...old, isEnabled: vars.isEnabled } : old
      );
      return { previous };
    },
    onError: (error, _vars, context) => {
      queryClient.setQueryData<SecurityAgentConfig>(configQueryKey, old =>
        old && context?.previous ? { ...old, isEnabled: context.previous.isEnabled } : old
      );
      announcingToast.error(error.message);
    },
    onSuccess: result => {
      if ('initialSyncAdmissionFailed' in result && result.initialSyncAdmissionFailed) {
        announcingToast.error(
          'Security Agent was enabled, but the initial sync could not be queued. Sync again.'
        );
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
  });
}

export function useTriggerSecuritySync(scope: string) {
  const queryClient = useQueryClient();
  const { getKey, rotateKey } = useHoistedOperationKey();
  // P1-E-40c: Security sync is reconcile-first — persist the row so a crash
  // mid-flight surfaces a card on relaunch instead of auto-replaying.
  const { writeReconcileFirst, remove: removeOutboxRow, whenLoaded } = useMutationOutbox();

  return useMutation({
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
        throw new Error('Could not read pending syncs. Try again.');
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
        if (!isSecuritySyncRetryable(error)) {
          rotateKey();
          await removeOutboxRow(fingerprint);
        }
        // A retryable (ambiguous) failure keeps the row: the server may have
        // accepted the command, so a relaunch must reconcile, not re-POST.
        throw mapSecuritySyncOperationError(error);
      }
    },
    onError: error => {
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
