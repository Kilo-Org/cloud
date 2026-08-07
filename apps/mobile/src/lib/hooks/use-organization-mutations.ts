import { useMutation, useQueryClient } from '@tanstack/react-query';

import { announcingToast } from '@/lib/a11y/announcing-toast';
import {
  type OrgListEntry,
  type OrgRole,
  type OrgWithMembers,
} from '@/lib/hooks/use-organization-queries';
import { classifyPrReviewMutationError } from '@/lib/pr-review/classify-pr-review-query-state';
import { useHoistedOperationKey } from '@/lib/pr-review/merge/pr-operation-ledger';
import { trpcClient, useTRPC } from '@/lib/trpc';

const onMutationError = (error: { message: string }) => {
  announcingToast.error(error.message || 'Something went wrong');
};

// P1-A-08e ledger markers (server contract, mirrored from
// organization-members-router.ts). The role-change and member-removal
// mutations carry an optional `operationKey`; these hooks hoist one key per
// intent so retries of the SAME intent dedupe/replay/conflict on the server.
// Only `operation_in_progress` is a raw marker — the server sends user-facing
// copy for every other ledger outcome, so it is the only one translated here.
const ORG_OPERATION_IN_PROGRESS_MESSAGE = 'operation_in_progress';
const ORG_OPERATION_REPLAY_FAILED_MESSAGE = 'This action did not complete. Please try again.';
const ORG_OPERATION_KEY_REUSE_MISMATCH_MESSAGE = 'operation_key_reuse_mismatch';
const ORG_LEDGER_SETTLE_FAILED_MESSAGE =
  'The action completed, but we could not record the result. Please try again.';

/** In-progress surface copy: reads like the existing retryable toasts. */
const ORG_OPERATION_IN_PROGRESS_COPY = 'This change is still being processed. Please try again.';

/**
 * True when the mutation may be retried under the SAME operation key.
 * Retryable: `operation_in_progress`, the settle-failed marker (a same-key
 * retry repairs the committed write by read-back), and generic transient
 * errors. Non-retryable: the replay-failed marker (the row settled `failed`),
 * the cross-intent key-reuse rejection, and typed validation/permission
 * errors — the next submit must be a fresh intent with a fresh key.
 */
export function isOrganizationMutationRetryable(error: unknown): boolean {
  if (error instanceof Error) {
    if (error.message === ORG_OPERATION_KEY_REUSE_MISMATCH_MESSAGE) {
      return false;
    }
    if (error.message === ORG_OPERATION_REPLAY_FAILED_MESSAGE) {
      return false;
    }
    if (error.message === ORG_LEDGER_SETTLE_FAILED_MESSAGE) {
      return true;
    }
  }
  return classifyPrReviewMutationError(error).kind === 'retryable';
}

/** Maps the raw in-progress marker onto retryable copy; other errors pass through. */
export function mapOrganizationOperationError(error: unknown): unknown {
  if (error instanceof Error && error.message === ORG_OPERATION_IN_PROGRESS_MESSAGE) {
    return new Error(ORG_OPERATION_IN_PROGRESS_COPY);
  }
  return error;
}

/**
 * Deterministic intent fingerprint for a role change. Every intent-defining
 * input is included: a retry of the SAME target+role reuses the hoisted key,
 * and any change (different member or role) rotates it so the ledger treats
 * the submit as a fresh intent.
 */
export function organizationRoleChangeIntentFingerprint(
  organizationId: string,
  memberId: string,
  role: OrgRole
): string {
  return JSON.stringify({ resource: [organizationId, memberId], role });
}

/** Deterministic intent fingerprint for a member removal. */
export function organizationRemoveMemberIntentFingerprint(
  organizationId: string,
  memberId: string
): string {
  return JSON.stringify({ resource: [organizationId, memberId] });
}

type UseOrganizationMutationsOptions = {
  /**
   * member-limit-sheet renders `updateMember` errors inline (Pattern P2) and
   * owns that mutation's error feedback for its caller. member-row.tsx's
   * action-sheet role change has no persistent surface to show an inline
   * error in, so it keeps the default toast — hence this is per-hook-call
   * rather than a blanket change to the mutation itself.
   */
  silenceUpdateMemberToast?: boolean;
};

export function useOrganizationMutations(
  organizationId: string,
  { silenceUpdateMemberToast }: UseOrganizationMutationsOptions = {}
) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  // One hoisted key state per operation family: a retryable role change must
  // keep its key even when a removal runs, and a removal must not rotate or
  // clear the role-change key. Two `useHoistedOperationKey` calls give each
  // family its own getKey/rotateKey pair instead of a shared single key state.
  const { getKey: getRoleKey, rotateKey: rotateRoleKey } = useHoistedOperationKey();
  const { getKey: getRemoveKey, rotateKey: rotateRemoveKey } = useHoistedOperationKey();

  const withMembersKey = trpc.organizations.withMembers.queryKey({ organizationId });
  const listKey = trpc.organizations.list.queryKey();

  const invalidateAll = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: withMembersKey }),
      queryClient.invalidateQueries({ queryKey: listKey }),
    ]);
  };

  const invalidateWithMembers = async () => {
    await queryClient.invalidateQueries({ queryKey: withMembersKey });
  };

  // Every optimistic mutation here only touches the withMembers cache, so the
  // key is fixed rather than threaded through like use-kiloclaw-mutations.ts
  // (which juggles many caches across a personal/org split).
  function optimistic<TInput>(
    updater: (old: OrgWithMembers, input: TInput) => OrgWithMembers,
    { silent }: { silent?: boolean } = {}
  ) {
    return {
      onMutate: async (input: TInput) => {
        await queryClient.cancelQueries({ queryKey: withMembersKey });
        const previous = queryClient.getQueryData<OrgWithMembers>(withMembersKey);
        queryClient.setQueryData<OrgWithMembers>(withMembersKey, old =>
          old ? updater(old, input) : old
        );
        return { previous };
      },
      onError: (
        error: { message: string },
        _input: TInput,
        context?: { previous?: OrgWithMembers }
      ) => {
        if (context?.previous) {
          queryClient.setQueryData(withMembersKey, context.previous);
        }
        if (!silent) {
          onMutationError(error);
        }
      },
      onSettled: invalidateAll,
    };
  }

  return {
    rename: useMutation({
      // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
      mutationFn: (input: { name: string }) =>
        trpcClient.organizations.update.mutate({ organizationId, name: input.name }),
      onMutate: async (input: { name: string }) => {
        await Promise.all([
          queryClient.cancelQueries({ queryKey: withMembersKey }),
          queryClient.cancelQueries({ queryKey: listKey }),
        ]);
        const previousWithMembers = queryClient.getQueryData<OrgWithMembers>(withMembersKey);
        const previousList = queryClient.getQueryData<OrgListEntry[]>(listKey);
        queryClient.setQueryData<OrgWithMembers>(withMembersKey, old =>
          old ? { ...old, name: input.name } : old
        );
        queryClient.setQueryData<OrgListEntry[]>(listKey, old =>
          old
            ? old.map(entry =>
                entry.organizationId === organizationId
                  ? { ...entry, organizationName: input.name }
                  : entry
              )
            : old
        );
        return { previousWithMembers, previousList };
      },
      // No onMutationError toast here: RenameModal (the only caller) shows
      // the error inline while it stays open (see Pattern P2).
      onError: (
        _error: { message: string },
        _input,
        context?: { previousWithMembers?: OrgWithMembers; previousList?: OrgListEntry[] }
      ) => {
        if (context?.previousWithMembers) {
          queryClient.setQueryData(withMembersKey, context.previousWithMembers);
        }
        if (context?.previousList) {
          queryClient.setQueryData(listKey, context.previousList);
        }
      },
      onSettled: invalidateAll,
    }),

    // No onMutationError toast here: invite-member-sheet (the only caller)
    // shows the error inline while it stays open (see Pattern P2).
    invite: useMutation({
      // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
      mutationFn: (input: { email: string; role: OrgRole }) =>
        trpcClient.organizations.members.invite.mutate({ organizationId, ...input }),
      onSuccess: invalidateWithMembers,
      onSettled: invalidateAll,
    }),

    updateMember: useMutation({
      mutationFn: async (input: {
        memberId: string;
        role?: OrgRole;
        dailyUsageLimitUsd?: number | null;
      }) => {
        // Only the role branch is ledger-backed (P1-A-08e); a limit-only
        // request carries no key. Key rotation (regenerate after a terminal
        // outcome) must therefore run only when a keyed role mutation actually
        // ran — a limit-only update must not clear the pending role-change key
        // hoisted for another intent.
        const isKeyedRoleMutation = input.role !== undefined;
        try {
          const result = await trpcClient.organizations.members.update.mutate({
            organizationId,
            ...input,
            ...(input.role !== undefined && {
              operationKey: getRoleKey(
                organizationRoleChangeIntentFingerprint(organizationId, input.memberId, input.role)
              ),
            }),
          });
          if (isKeyedRoleMutation) {
            rotateRoleKey();
          }
          return result;
        } catch (error) {
          if (isKeyedRoleMutation && !isOrganizationMutationRetryable(error)) {
            rotateRoleKey();
          }
          throw mapOrganizationOperationError(error);
        }
      },
      ...optimistic<{ memberId: string; role?: OrgRole; dailyUsageLimitUsd?: number | null }>(
        (old, input) => ({
          ...old,
          members: old.members.map(member =>
            member.status === 'active' && member.id === input.memberId
              ? {
                  ...member,
                  ...(input.role !== undefined && { role: input.role }),
                  ...(input.dailyUsageLimitUsd !== undefined && {
                    dailyUsageLimitUsd: input.dailyUsageLimitUsd,
                  }),
                }
              : member
          ),
        }),
        { silent: silenceUpdateMemberToast }
      ),
    }),

    removeMember: useMutation({
      mutationFn: async (input: { memberId: string }) => {
        try {
          const result = await trpcClient.organizations.members.remove.mutate({
            organizationId,
            ...input,
            operationKey: getRemoveKey(
              organizationRemoveMemberIntentFingerprint(organizationId, input.memberId)
            ),
          });
          rotateRemoveKey();
          return result;
        } catch (error) {
          if (!isOrganizationMutationRetryable(error)) {
            rotateRemoveKey();
          }
          throw mapOrganizationOperationError(error);
        }
      },
      ...optimistic<{ memberId: string }>((old, input) => ({
        ...old,
        members: old.members.filter(
          member => !(member.status === 'active' && member.id === input.memberId)
        ),
      })),
    }),

    deleteInvite: useMutation({
      // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
      mutationFn: (input: { inviteId: string }) =>
        trpcClient.organizations.members.deleteInvite.mutate({ organizationId, ...input }),
      ...optimistic<{ inviteId: string }>((old, input) => ({
        ...old,
        members: old.members.filter(
          member => !(member.status === 'invited' && member.inviteId === input.inviteId)
        ),
      })),
    }),

    // No onMutationError toast here: low-balance-alert-sheet (the only
    // caller) shows the error inline while it stays open (see Pattern P2).
    updateMinimumBalanceAlert: useMutation({
      // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
      mutationFn: (input: {
        enabled: boolean;
        minimum_balance?: number;
        minimum_balance_alert_email?: string[];
      }) =>
        trpcClient.organizations.settings.updateMinimumBalanceAlert.mutate({
          organizationId,
          ...input,
        }),
      ...optimistic<{
        enabled: boolean;
        minimum_balance?: number;
        minimum_balance_alert_email?: string[];
      }>(
        (old, input) => {
          if (input.enabled) {
            return {
              ...old,
              settings: {
                ...old.settings,
                minimum_balance: input.minimum_balance,
                minimum_balance_alert_email: input.minimum_balance_alert_email,
              },
            };
          }
          const {
            minimum_balance: _mb,
            minimum_balance_alert_email: _mbae,
            ...rest
          } = old.settings;
          return { ...old, settings: rest };
        },
        { silent: true }
      ),
    }),
  };
}
