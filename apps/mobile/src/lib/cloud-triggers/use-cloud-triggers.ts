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
import {
  isLatestMutationGeneration,
  nextMutationGeneration,
} from '@/lib/hooks/mutation-generations';
import { useTRPC } from '@/lib/trpc';

import { type CloudTriggerListRow } from './trigger-draft';

/** The procedures' scope input: an organization, or the caller's own triggers. */
function triggerScope(organizationId: string | undefined): { organizationId?: string } {
  return organizationId === undefined ? {} : { organizationId };
}

/**
 * The list input. Every screen here manages the Cloud Agent target only, so a
 * legacy KiloClaw trigger is never listed as a row this form cannot save.
 */
function triggerListInput(organizationId: string | undefined) {
  return { ...triggerScope(organizationId), targetType: 'cloud_agent' as const };
}

export function useCloudTriggers(organizationId: string | undefined, enabled: boolean) {
  const trpc = useTRPC();
  return useQuery(
    trpc.webhookTriggers.list.queryOptions(triggerListInput(organizationId), { enabled })
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
export function useTriggerMutations(triggerId: string | null, organizationId: string | undefined) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const scope = triggerScope(organizationId);
  const listKey = trpc.webhookTriggers.list.queryKey(triggerListInput(organizationId));
  // One key per list, so a rollback knows whether a newer toggle has landed since.
  const listGenerationKey = `webhook-triggers-list:${organizationId ?? 'personal'}`;

  const settleList = () => {
    void queryClient.invalidateQueries(trpc.webhookTriggers.list.pathFilter());
  };

  const setActive = useMutation(
    trpc.webhookTriggers.update.mutationOptions({
      onMutate: async input => {
        await queryClient.cancelQueries({ queryKey: listKey });
        const generation = nextMutationGeneration(listGenerationKey);
        const previous = queryClient.getQueryData<CloudTriggerListRow[]>(listKey);
        queryClient.setQueryData<CloudTriggerListRow[]>(listKey, rows =>
          rows?.map(row =>
            row.triggerId === input.triggerId
              ? { ...row, isActive: input.isActive ?? row.isActive }
              : row
          )
        );
        return { generation, previous };
      },
      // A failed toggle restores only the snapshot it took: a newer toggle's own
      // write stays in the cache instead of being rolled back to an older list.
      onError: (error, _input, context) => {
        if (
          context &&
          isLatestMutationGeneration(listGenerationKey, context.generation) &&
          context.previous !== undefined
        ) {
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
        void queryClient.invalidateQueries(trpc.webhookTriggers.listRequests.pathFilter());
        settleList();
      },
      onError: error => toast.error(error.message),
    })
  );

  const invoke = useMutation(
    trpc.webhookTriggers.invoke.mutationOptions({
      onSuccess: () => {
        announcingToast.success(i18n.t('cloudAgent.triggers.runStarted'));
        void queryClient.invalidateQueries(trpc.webhookTriggers.listRequests.pathFilter());
      },
      onError: error => toast.error(error.message),
    })
  );

  return { setActive, remove, invoke };
}
