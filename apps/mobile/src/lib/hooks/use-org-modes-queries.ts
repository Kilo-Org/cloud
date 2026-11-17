import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { type OrgModeConfigInput } from '@/components/organization/org-mode-form-model';
import { announcingToast } from '@/lib/a11y/announcing-toast';
import { organizationErrorMessage } from '@/lib/server-error-copy';
import { trpcClient, useTRPC } from '@/lib/trpc';

/**
 * The organization's stored modes. `organizationMemberProcedure`, so every
 * member may read the list; a stored mode whose slug matches a built-in one
 * replaces that built-in mode.
 */
export function useOrgModes(organizationId: string | null) {
  const trpc = useTRPC();
  return useQuery(
    trpc.organizations.modes.list.queryOptions(
      { organizationId: organizationId ?? '' },
      { enabled: organizationId != null }
    )
  );
}

/**
 * Create, update and delete for the organization's modes. The web page shows
 * these controls to every member (the router's own procedures are member
 * mutations), so the screens gate on membership and these leave the policy to
 * the server.
 */
export function useOrgModeMutations(organizationId: string) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const modesFilter = trpc.organizations.modes.pathFilter();
  const scope = { id: `organization-modes:${organizationId}` };
  const onError = (error: unknown) => {
    announcingToast.error(organizationErrorMessage(error));
  };
  const onSuccess = () => {
    void queryClient.invalidateQueries(modesFilter);
  };

  return {
    create: useMutation({
      mutationFn: (input: { name: string; slug: string; config: OrgModeConfigInput }) =>
        trpcClient.organizations.modes.create.mutate({ organizationId, ...input }),
      onSuccess,
      onError,
      scope,
    }),
    update: useMutation({
      mutationFn: (input: {
        modeId: string;
        name: string;
        slug: string;
        config: OrgModeConfigInput;
      }) => trpcClient.organizations.modes.update.mutate({ organizationId, ...input }),
      onSuccess,
      onError,
      scope,
    }),
    remove: useMutation({
      mutationFn: (input: { modeId: string }) =>
        trpcClient.organizations.modes.delete.mutate({ organizationId, modeId: input.modeId }),
      onSuccess,
      onError,
      scope,
    }),
  };
}
