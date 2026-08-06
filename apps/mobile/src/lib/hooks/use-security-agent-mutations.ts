import { isPersonalSecurityScope } from '@kilocode/app-shared/security-agent';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { announcingToast } from '@/lib/a11y/announcing-toast';
import { trackSecurityAgentCommand } from '@/lib/hooks/use-security-agent-commands';
import { classifyPrReviewMutationError } from '@/lib/pr-review/classify-pr-review-query-state';
import { useHoistedOperationKey } from '@/lib/pr-review/merge/pr-operation-ledger';
import { type SecurityAgentConfig, type SecurityAgentConfigPatch } from '@/lib/security-agent';
import { trpcClient, useTRPC } from '@/lib/trpc';
import { pick } from '@/lib/utils';

// P1-A-08e ledger markers (server contract, mirrored from
// shared-handlers.ts). The manual-sync command carries an optional
// `operationKey`; `useTriggerSecuritySync` hoists one key per intent so
// retries of the SAME intent dedupe/replay/conflict on the server. Only
// `operation_in_progress` is a raw marker — the server sends user-facing copy
// for every other ledger outcome, so it is the only one translated here.
const SECURITY_OPERATION_IN_PROGRESS_MESSAGE = 'operation_in_progress';
const SECURITY_OPERATION_REPLAY_FAILED_MESSAGE = 'This action did not complete. Please try again.';
const SECURITY_OPERATION_KEY_REUSE_MISMATCH_MESSAGE = 'operation_key_reuse_mismatch';
// The ambiguous transport outcome: the Worker may have accepted the command.
// Retryable under the SAME key — the server reconciles instead of
// re-submitting blind.
const SECURITY_AMBIGUOUS_MESSAGE = "Couldn't confirm — check the security review before retrying.";
// A provider-confirmed outcome whose settle failed: a same-key retry
// re-submits and re-records the acceptance. Retryable.
const SECURITY_LEDGER_SETTLE_FAILED_MESSAGE =
  'The action completed, but we could not record the result. Please try again.';
// The ambiguous outcome could NOT be recorded as reconcile-pending, so the
// same-key retry guarantee does not hold. Non-retryable: the next submit must
// be a fresh intent with a fresh key.
const SECURITY_LEDGER_PERSISTENCE_FAILED_MESSAGE =
  'We could not record this action. Please try again later.';

// Server-side missing Worker configuration: the manual-sync Worker URL or the
// internal secret is unset. Mirrored from the web manual-sync and
// manual-dismiss clients. The command can never be accepted until the
// deployment is reconfigured, so this outcome is non-retryable — a resubmit
// fails identically.
export const SECURITY_SERVICE_NOT_CONFIGURED_MESSAGE = 'Security service is not configured';

/** Surface copy for the missing-configuration state (dismiss sheet). */
export const SECURITY_CONFIGURATION_COPY =
  'Security service is not configured. Resubmitting cannot succeed until this is fixed.';

/** True when the error is the server's missing-Worker-configuration rejection. */
export function isSecurityConfigurationError(error: unknown): boolean {
  return error instanceof Error && error.message === SECURITY_SERVICE_NOT_CONFIGURED_MESSAGE;
}

/** In-progress surface copy: reads like the existing retryable toasts. */
const SECURITY_SYNC_IN_PROGRESS_COPY = 'A security sync is already in progress. Please try again.';

/**
 * True when the sync may be retried under the SAME operation key. Retryable:
 * `operation_in_progress`, the ambiguous outcome (reconcile-pending), the
 * settle-failed marker, and generic transient errors. Non-retryable: the
 * missing-Worker-configuration rejection, the replay-failed marker, the
 * persistence-failure marker (the reconcile-pending guarantee does not hold),
 * the cross-intent key-reuse rejection, and typed validation/permission
 * errors — the next submit must be a fresh intent.
 */
export function isSecuritySyncRetryable(error: unknown): boolean {
  if (error instanceof Error) {
    if (isSecurityConfigurationError(error)) {
      return false;
    }
    if (error.message === SECURITY_OPERATION_KEY_REUSE_MISMATCH_MESSAGE) {
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

/** Maps the raw in-progress marker onto retryable copy; other errors pass through. */
export function mapSecuritySyncOperationError(error: unknown): unknown {
  if (error instanceof Error && error.message === SECURITY_OPERATION_IN_PROGRESS_MESSAGE) {
    return new Error(SECURITY_SYNC_IN_PROGRESS_COPY);
  }
  return error;
}

/**
 * Deterministic intent fingerprint for a manual sync. A retry of the SAME
 * scope+repo reuses the hoisted key; changing the repo (or the scope) rotates
 * it so the ledger treats the submit as a fresh intent.
 */
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
    mutationFn: (patch: SecurityAgentConfigPatch) =>
      isPersonalSecurityScope(scope)
        ? trpcClient.securityAgent.saveConfig.mutate(patch)
        : trpcClient.organizations.securityAgent.saveConfig.mutate({
            organizationId: scope,
            ...patch,
          }),
    onMutate: async patch => {
      await queryClient.cancelQueries({ queryKey: configQueryKey });
      const previous = queryClient.getQueryData<SecurityAgentConfig>(configQueryKey);
      queryClient.setQueryData<SecurityAgentConfig>(configQueryKey, old =>
        old ? { ...old, ...patch } : old
      );
      return { previous, patch };
    },
    onError: (error, _patch, context) => {
      if (context?.previous) {
        const keys = Object.keys(context.patch) as (keyof SecurityAgentConfigPatch)[];
        const restoredFields = pick(context.previous, keys);
        queryClient.setQueryData<SecurityAgentConfig>(configQueryKey, old =>
          old ? { ...old, ...restoredFields } : old
        );
      }
      announcingToast.error(error.message);
    },
    onSuccess: result => {
      if (result.existingRemediationCommandId) {
        trackSecurityAgentCommand(queryClient, scope, result.existingRemediationCommandId);
      }
      if (result.backlogAdmissionWarning) {
        announcingToast.error(result.backlogAdmissionWarning);
      }
      if (result.remediationBacklogAdmissionWarning) {
        announcingToast.error(result.remediationBacklogAdmissionWarning);
      }
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: configQueryKey });
      if (isPersonalSecurityScope(scope)) {
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: trpc.securityAgent.getDashboardStats.queryKey(),
          }),
          queryClient.invalidateQueries({ queryKey: trpc.securityAgent.listFindings.queryKey() }),
        ]);
        return;
      }
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: trpc.organizations.securityAgent.getDashboardStats.queryKey({
            organizationId: scope,
          }),
        }),
        queryClient.invalidateQueries({
          queryKey: trpc.organizations.securityAgent.listFindings.queryKey({
            organizationId: scope,
          }),
        }),
      ]);
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

  return useMutation({
    mutationFn: async (
      vars: Parameters<typeof trpcClient.securityAgent.triggerSync.mutate>[0] = {}
    ) => {
      const operationKey = getKey(securitySyncIntentFingerprint(scope, vars.repoFullName));
      try {
        const result = isPersonalSecurityScope(scope)
          ? await trpcClient.securityAgent.triggerSync.mutate({ ...vars, operationKey })
          : await trpcClient.organizations.securityAgent.triggerSync.mutate({
              organizationId: scope,
              ...vars,
              operationKey,
            });
        rotateKey();
        return result;
      } catch (error) {
        if (!isSecuritySyncRetryable(error)) {
          rotateKey();
        }
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
