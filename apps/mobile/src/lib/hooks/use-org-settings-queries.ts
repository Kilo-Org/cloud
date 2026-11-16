import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';
import { toast } from 'sonner-native';

import { SETTLE_WHILE_OFFLINE } from '@/lib/query/settle-while-offline';
import { useTRPC } from '@/lib/trpc';

type RouterOutputs = inferRouterOutputs<MobileRouter>;

/**
 * One organization's AI guardrail configuration and the save that replaces it.
 *
 * `enabled` must be the screen's own resolved permission: both procedures are
 * `organizationAdmin` ones, so a member's read would be refused rather than
 * answered emptily.
 */
export function useOrgGuardrails(organizationId: string | null, enabled: boolean) {
  const trpc = useTRPC();
  return useQuery(
    trpc.organizations.guardrails.get.queryOptions(
      { organizationId: organizationId ?? '' },
      { enabled: enabled && organizationId != null, ...SETTLE_WHILE_OFFLINE }
    )
  );
}

export function useSaveOrgGuardrails(organizationId: string | null) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  return useMutation(
    trpc.organizations.guardrails.update.mutationOptions({
      networkMode: 'always',
      onSuccess: async result => {
        if (organizationId != null) {
          queryClient.setQueryData(
            trpc.organizations.guardrails.get.queryKey({ organizationId }),
            result
          );
        }
        await queryClient.invalidateQueries({
          queryKey: trpc.organizations.withMembers.queryKey({
            organizationId: organizationId ?? '',
          }),
        });
      },
      onError: (error: { message: string }) => {
        toast.error(error.message);
      },
    })
  );
}

/** The model catalog this organization may use, as the member audience sees it. */
export function useOrgAvailableModels(organizationId: string | null, enabled: boolean) {
  const trpc = useTRPC();
  return useQuery(
    trpc.organizations.settings.listAvailableModels.queryOptions(
      { organizationId: organizationId ?? '', audience: 'member' },
      { enabled: enabled && organizationId != null, ...SETTLE_WHILE_OFFLINE }
    )
  );
}

/** The gateway's own two settings; `available` says whether the organization may change them. */
export function useOrgGatewaySettings(organizationId: string | null, enabled: boolean) {
  const trpc = useTRPC();
  return useQuery(
    trpc.organizations.settings.getGatewaySettings.queryOptions(
      { organizationId: organizationId ?? '' },
      { enabled: enabled && organizationId != null, ...SETTLE_WHILE_OFFLINE }
    )
  );
}

/** The gateway settings payload both the query and the screen's props name. */
export type OrgGatewaySettings = RouterOutputs['organizations']['settings']['getGatewaySettings'];

/**
 * Saves both access lists at once, as the web page's Save does: the procedure
 * takes the provider allow list and the model deny list together so one write
 * cannot drop the organization's default model against the other list.
 */
export function useSaveOrgModelAccess(organizationId: string | null) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  return useMutation(
    trpc.organizations.settings.updateAllowLists.mutationOptions({
      networkMode: 'always',
      onSuccess: async () => {
        if (organizationId != null) {
          await Promise.all([
            queryClient.invalidateQueries({
              queryKey: trpc.organizations.withMembers.queryKey({ organizationId }),
            }),
            queryClient.invalidateQueries({
              queryKey: trpc.organizations.list.queryKey(),
            }),
            queryClient.invalidateQueries({
              queryKey: trpc.organizations.settings.listAvailableModels.queryKey({
                organizationId,
                audience: 'member',
              }),
            }),
          ]);
        }
      },
      onError: (error: { message: string }) => {
        toast.error(error.message);
      },
    })
  );
}

export function useSaveOrgGatewaySettings(organizationId: string | null) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  return useMutation(
    trpc.organizations.settings.updateGatewaySettings.mutationOptions({
      networkMode: 'always',
      onSuccess: async () => {
        if (organizationId != null) {
          await queryClient.invalidateQueries({
            queryKey: trpc.organizations.settings.getGatewaySettings.queryKey({ organizationId }),
          });
        }
      },
      onError: (error: { message: string }) => {
        toast.error(error.message);
      },
    })
  );
}
