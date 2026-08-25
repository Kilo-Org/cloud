import { hashKey, useMutation, useQueryClient } from '@tanstack/react-query';

import { announcingToast } from '@/lib/a11y/announcing-toast';
import {
  isLatestMutationGeneration,
  nextMutationGeneration,
} from '@/lib/hooks/mutation-generations';
import {
  type OrgListEntry,
  type OrgRole,
  type OrgWithMembers,
} from '@/lib/hooks/use-organization-queries';
import { trpcClient, useTRPC } from '@/lib/trpc';

const onMutationError = (error: { message: string }) => {
  announcingToast.error(error.message || 'Something went wrong');
};

// Distributive helpers: `OrgWithMembers` is a union of the admin and member
// variants, so a plain `{ ...old, members: ... }` spread loses the variant
// correlation. These preserve it by mapping over `T['members']` for the
// concrete `T`.
function mapMembers<T extends OrgWithMembers>(
  old: T,
  fn: (member: T['members'][number]) => T['members'][number]
): T {
  return { ...old, members: old.members.map(fn) };
}

function filterMembers<T extends OrgWithMembers>(
  old: T,
  fn: (member: T['members'][number]) => boolean
): T {
  return { ...old, members: old.members.filter(fn) };
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
  // onError policy: roll back the onMutate snapshot (latest generation only);
  // toast error.message, or the caller renders the error inline when silent.
  function optimistic<TInput>(
    updater: (old: OrgWithMembers, input: TInput) => OrgWithMembers,
    { silent }: { silent?: boolean } = {}
  ) {
    return {
      onMutate: async (input: TInput) => {
        await queryClient.cancelQueries({ queryKey: withMembersKey });
        const generation = nextMutationGeneration(hashKey(withMembersKey));
        const previous = queryClient.getQueryData<OrgWithMembers>(withMembersKey);
        queryClient.setQueryData<OrgWithMembers>(withMembersKey, old =>
          old ? updater(old, input) : old
        );
        return { previous, generation };
      },
      onError: (
        error: { message: string },
        _input: TInput,
        context?: { previous?: OrgWithMembers; generation: number }
      ) => {
        if (
          context?.previous &&
          isLatestMutationGeneration(hashKey(withMembersKey), context.generation)
        ) {
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
    // onError policy: roll back the onMutate snapshot (latest generation only);
    // the caller renders the error inline (no toast).
    rename: useMutation({
      // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
      mutationFn: (input: { name: string }) =>
        trpcClient.organizations.update.mutate({ organizationId, name: input.name }),
      onMutate: async (input: { name: string }) => {
        await Promise.all([
          queryClient.cancelQueries({ queryKey: withMembersKey }),
          queryClient.cancelQueries({ queryKey: listKey }),
        ]);
        const generation = nextMutationGeneration(hashKey(withMembersKey));
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
        return { previousWithMembers, previousList, generation };
      },
      // No onMutationError toast here: RenameModal (the only caller) shows
      // the error inline while it stays open (see Pattern P2).
      onError: (
        _error: { message: string },
        _input,
        context?: {
          previousWithMembers?: OrgWithMembers;
          previousList?: OrgListEntry[];
          generation: number;
        }
      ) => {
        if (
          context?.previousWithMembers &&
          isLatestMutationGeneration(hashKey(withMembersKey), context.generation)
        ) {
          queryClient.setQueryData(withMembersKey, context.previousWithMembers);
        }
        if (
          context?.previousList &&
          isLatestMutationGeneration(hashKey(withMembersKey), context.generation)
        ) {
          queryClient.setQueryData(listKey, context.previousList);
        }
      },
      onSettled: invalidateAll,
      // Serialize rename against the other optimistic org writes so the
      // network calls land in order; the generation guard orders rollbacks.
      scope: { id: `organization:${organizationId}` },
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
      // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
      mutationFn: (input: {
        memberId: string;
        role?: OrgRole;
        dailyUsageLimitUsd?: number | null;
      }) => trpcClient.organizations.members.update.mutate({ organizationId, ...input }),
      ...optimistic<{ memberId: string; role?: OrgRole; dailyUsageLimitUsd?: number | null }>(
        (old, input) =>
          mapMembers(old, member =>
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
        { silent: silenceUpdateMemberToast }
      ),
      scope: { id: `organization:${organizationId}` },
    }),

    removeMember: useMutation({
      // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
      mutationFn: (input: { memberId: string }) =>
        trpcClient.organizations.members.remove.mutate({ organizationId, ...input }),
      ...optimistic<{ memberId: string }>((old, input) =>
        filterMembers(old, member => !(member.status === 'active' && member.id === input.memberId))
      ),
      scope: { id: `organization:${organizationId}` },
    }),

    deleteInvite: useMutation({
      // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
      mutationFn: (input: { inviteId: string }) =>
        trpcClient.organizations.members.deleteInvite.mutate({ organizationId, ...input }),
      ...optimistic<{ inviteId: string }>((old, input) =>
        filterMembers(
          old,
          member => !(member.status === 'invited' && member.inviteId === input.inviteId)
        )
      ),
      scope: { id: `organization:${organizationId}` },
    }),

    // No onMutationError toast here: low-balance-alert-sheet (the only
    // caller) shows the error inline while it stays open (see Pattern P2).
    // onError policy: roll back the onMutate snapshot (latest generation only);
    // the caller renders the error inline (no toast).
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
      scope: { id: `organization:${organizationId}` },
    }),
  };
}
