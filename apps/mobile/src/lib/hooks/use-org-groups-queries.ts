import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { announcingToast } from '@/lib/a11y/announcing-toast';
import { organizationErrorMessage } from '@/lib/server-error-copy';
import { trpcClient, useTRPC } from '@/lib/trpc';

type RouterOutputs = inferRouterOutputs<MobileRouter>;

type OrgGroupList = RouterOutputs['organizations']['groups']['list'];

/** A group as a manager sees it: its metadata, policies and member ids. */
export type OrgGroup = Extract<OrgGroupList, { access: 'manager' }>['groups'][number];

/**
 * The organization's groups. The procedure answers a manager shape (every
 * group, with its members and policies) to an owner, admin or billing manager,
 * and a member shape (the caller's own groups) to everyone else, so the screen
 * renders whichever arrived.
 */
export function useOrgGroups(organizationId: string | null, enabled: boolean) {
  const trpc = useTRPC();
  return useQuery(
    trpc.organizations.groups.list.queryOptions(
      { organizationId: organizationId ?? '' },
      { enabled: enabled && organizationId != null }
    )
  );
}

/**
 * Create, update and delete for the organization's groups. Every one of these is
 * `organizationAdminMutationProcedure`, so the screens show them to an owner or
 * admin only and the server refuses anyone else.
 */
export function useOrgGroupMutations(organizationId: string) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const groupsFilter = trpc.organizations.groups.pathFilter();
  const scope = { id: `organization-groups:${organizationId}` };
  const onError = (error: unknown) => {
    announcingToast.error(organizationErrorMessage(error));
  };
  const onSuccess = () => {
    void queryClient.invalidateQueries(groupsFilter);
  };

  return {
    create: useMutation({
      mutationFn: (input: { name: string; description: string | null }) =>
        trpcClient.organizations.groups.create.mutate({
          organizationId,
          name: input.name,
          description: input.description,
          policies: [],
        }),
      onSuccess,
      onError,
      scope,
    }),
    updateDetails: useMutation({
      mutationFn: (input: {
        groupId: string;
        name: string;
        description: string | null;
        userIds: readonly string[];
      }) =>
        trpcClient.organizations.groups.updateDetails.mutate({
          organizationId,
          groupId: input.groupId,
          name: input.name,
          description: input.description,
          userIds: [...input.userIds],
        }),
      onSuccess,
      onError,
      scope,
    }),
    remove: useMutation({
      mutationFn: (input: { groupId: string }) =>
        trpcClient.organizations.groups.delete.mutate({ organizationId, groupId: input.groupId }),
      onSuccess,
      onError,
      scope,
    }),
  };
}
