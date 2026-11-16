/**
 * The Cloud Agent trigger reads and writes every trigger screen shares.
 *
 * One scope helper decides the input shape: no `organizationId` is the caller's
 * own triggers, and the same string switches every call to an organization's.
 * The list key is invalidated by every write that changes a row, so the list and
 * the detail screen never disagree about what a trigger is.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner-native';

import { i18n } from '@/i18n';
import { announcingToast } from '@/lib/a11y/announcing-toast';
import { useTRPC } from '@/lib/trpc';

import { type CloudTriggerListRow } from './trigger-draft';

/** The procedures' scope input: an organization, or the caller's own triggers. */
export function triggerScope(organizationId: string | undefined): { organizationId?: string } {
  return organizationId === undefined ? {} : { organizationId };
}

export function useCloudTriggers(organizationId: string | undefined, enabled: boolean) {
  const trpc = useTRPC();
  return useQuery(
    trpc.webhookTriggers.list.queryOptions(triggerScope(organizationId), { enabled })
  );
}

export function useCloudTrigger(
  triggerId: string,
  organizationId: string | undefined,
  enabled: boolean
) {
  const trpc = useTRPC();
  return useQuery(
    trpc.webhookTriggers.get.queryOptions(
      { triggerId, ...triggerScope(organizationId) },
      // A trigger whose configuration the worker answers 404 for has no retry
      // that helps: the screen shows its own not-found state instead.
      { enabled, retry: false }
    )
  );
}

export function useTriggerDeliveries(
  triggerId: string,
  organizationId: string | undefined,
  enabled: boolean
) {
  const trpc = useTRPC();
  return useQuery(
    trpc.webhookTriggers.listRequests.queryOptions(
      { triggerId, limit: 20, ...triggerScope(organizationId) },
      { enabled }
    )
  );
}

/**
 * The writes. Each mutation settles the list so a changed row is the one the
 * server holds, and the delete also drops the detail read so a deleted trigger
 * cannot render from cache when its screen is revisited.
 *
 * `update` is optimistic on the list only for the active switch: that is one
 * boolean the server echoes, so the switch answers the tap at once and rolls
 * back when the write fails. Every other edit reloads the row from the server.
 */
export function useTriggerMutations(
  triggerId: string | null,
  organizationId: string | undefined
) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const scope = triggerScope(organizationId);
  const listKey = trpc.webhookTriggers.list.queryKey(scope);

  const settleList = () => {
    void queryClient.invalidateQueries(trpc.webhookTriggers.list.pathFilter());
  };

  const setActive = useMutation(
    trpc.webhookTriggers.update.mutationOptions({
      onMutate: async input => {
        await queryClient.cancelQueries({ queryKey: listKey });
        const previous = queryClient.getQueryData<CloudTriggerListRow[]>(listKey);
        queryClient.setQueryData<CloudTriggerListRow[]>(listKey, rows =>
          rows?.map(row =>
            row.triggerId === input.triggerId
              ? { ...row, isActive: input.isActive ?? row.isActive }
              : row
          )
        );
        return { previous };
      },
      onError: (error, _input, context) => {
        if (context?.previous !== undefined) {
          queryClient.setQueryData(listKey, context.previous);
        }
        toast.error(error.message);
      },
      onSettled: settleList,
    })
  );

  const remove = useMutation(
    trpc.webhookTriggers.delete.mutationOptions({
      onSuccess: () => {
        if (triggerId !== null) {
          queryClient.removeQueries({
            queryKey: trpc.webhookTriggers.get.queryKey({ triggerId, ...scope }),
          });
        }
        void queryClient.invalidateQueries({
          queryKey: trpc.webhookTriggers.listRequests.pathFilter(),
        });
        settleList();
      },
      onError: error => toast.error(error.message),
    })
  );

  const invoke = useMutation(
    trpc.webhookTriggers.invoke.mutationOptions({
      onSuccess: () => {
        announcingToast.success(i18n.t('cloudAgent.triggers.runStarted'));
        void queryClient.invalidateQueries({
          queryKey: trpc.webhookTriggers.listRequests.pathFilter(),
        });
      },
      onError: error => toast.error(error.message),
    })
  );

  return { setActive, remove, invoke };
}
