import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner-native';

import { agentProfileMutationErrorMessage } from '@/lib/agent-profile-error-copy';
import { withOrganization } from '@/lib/hooks/agent-profile-mutation-helpers';
import {
  type AgentProfileDetail,
  type AgentProfileInstructionRow,
} from '@/lib/hooks/agent-profile-types';
import {
  isLatestMutationGeneration,
  nextMutationGeneration,
} from '@/lib/hooks/mutation-generations';
import { useTRPC } from '@/lib/trpc';

// Optimistic writes on the same cache region are generation-stamped so an older
// mutation's rollback cannot stomp a newer mutation's optimistic value.
const INSTRUCTION_MUTATION_KEY = 'agentProfiles:instruction';

function withInstructionEnabled(
  instructions: AgentProfileInstructionRow[],
  instructionId: string,
  enabled: boolean
): AgentProfileInstructionRow[] {
  return instructions.map(instruction =>
    instruction.id === instructionId ? { ...instruction, enabled } : instruction
  );
}

/**
 * Every mutation the profile Instructions screen calls. A failed call toasts
 * `error.message` once, and each success invalidates the `agentProfiles`
 * namespace so the list, the overview's count, and the profile read the screen
 * renders reconcile with server truth.
 *
 * `setInstructionEnabled` is optimistic: it snapshots the profile read in
 * `onMutate`, rolls back in `onError` (latest generation only), and invalidates
 * again in `onSettled` to reconcile.
 */
export function useAgentProfileInstructionMutations(organizationId?: string) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const profilesFilter = trpc.agentProfiles.pathFilter();

  const invalidateProfiles = () => {
    void queryClient.invalidateQueries(profilesFilter);
  };
  const toastError = (error: { message: string }) => {
    toast.error(agentProfileMutationErrorMessage(error.message));
  };
  // `networkMode: 'always'` keeps a save settling while the online manager is
  // offline, so the sheet's save button always returns to idle.
  const callbacks = {
    networkMode: 'always' as const,
    onSuccess: invalidateProfiles,
    onError: (error: { message: string }) => {
      toastError(error);
    },
  };

  const createInstruction = useMutation(
    withOrganization(
      trpc.agentProfiles.createInstruction.mutationOptions(callbacks),
      organizationId
    )
  );
  const updateInstruction = useMutation(
    withOrganization(
      trpc.agentProfiles.updateInstruction.mutationOptions(callbacks),
      organizationId
    )
  );
  const deleteInstruction = useMutation(
    withOrganization(
      trpc.agentProfiles.deleteInstruction.mutationOptions(callbacks),
      organizationId
    )
  );

  const setInstructionEnabled = useMutation(
    withOrganization(
      trpc.agentProfiles.setInstructionEnabled.mutationOptions({
        ...callbacks,
        onMutate: async variables => {
          const detailFilter = trpc.agentProfiles.get.queryFilter({
            profileId: variables.profileId,
            organizationId,
          });
          await queryClient.cancelQueries(detailFilter);
          const generation = nextMutationGeneration(INSTRUCTION_MUTATION_KEY);
          const previous = queryClient.getQueriesData<AgentProfileDetail>(detailFilter);
          queryClient.setQueriesData<AgentProfileDetail>(detailFilter, old =>
            old
              ? {
                  ...old,
                  instructions: withInstructionEnabled(
                    old.instructions,
                    variables.instructionId,
                    variables.enabled
                  ),
                }
              : old
          );
          return { generation, previous };
        },
        onError: (error, _variables, context) => {
          if (context && isLatestMutationGeneration(INSTRUCTION_MUTATION_KEY, context.generation)) {
            for (const [key, data] of context.previous) {
              queryClient.setQueryData(key, data);
            }
          }
          toastError(error);
        },
        onSettled: invalidateProfiles,
      }),
      organizationId
    )
  );

  return { createInstruction, updateInstruction, deleteInstruction, setInstructionEnabled };
}
