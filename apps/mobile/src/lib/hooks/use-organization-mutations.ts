import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner-native';

import {
  type OrgListEntry,
  type OrgRole,
  type OrgWithMembers,
} from '@/lib/hooks/use-organization-queries';
import { trpcClient, useTRPC } from '@/lib/trpc';

const onMutationError = (error: { message: string }) => {
  toast.error(error.message || 'Something went wrong');
};

export function useOrganizationMutations(organizationId: string) {
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
  function optimistic<TInput>(updater: (old: OrgWithMembers, input: TInput) => OrgWithMembers) {
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
        onMutationError(error);
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
      onError: (
        error: { message: string },
        _input,
        context?: { previousWithMembers?: OrgWithMembers; previousList?: OrgListEntry[] }
      ) => {
        if (context?.previousWithMembers) {
          queryClient.setQueryData(withMembersKey, context.previousWithMembers);
        }
        if (context?.previousList) {
          queryClient.setQueryData(listKey, context.previousList);
        }
        onMutationError(error);
      },
      onSettled: invalidateAll,
    }),

    invite: useMutation({
      // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
      mutationFn: (input: { email: string; role: OrgRole }) =>
        trpcClient.organizations.members.invite.mutate({ organizationId, ...input }),
      onSuccess: invalidateWithMembers,
      onError: onMutationError,
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
        })
      ),
    }),

    removeMember: useMutation({
      // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
      mutationFn: (input: { memberId: string }) =>
        trpcClient.organizations.members.remove.mutate({ organizationId, ...input }),
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
      }>((old, input) => {
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
        const { minimum_balance: _mb, minimum_balance_alert_email: _mbae, ...rest } = old.settings;
        return { ...old, settings: rest };
      }),
    }),
  };
}
