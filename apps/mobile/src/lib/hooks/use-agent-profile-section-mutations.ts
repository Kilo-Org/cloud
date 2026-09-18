import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner-native';

import { withOrganization } from '@/lib/hooks/agent-profile-mutation-helpers';
import { type AgentProfileDetail } from '@/lib/hooks/agent-profile-types';
import {
  isLatestMutationGeneration,
  nextMutationGeneration,
} from '@/lib/hooks/mutation-generations';
import { useTRPC } from '@/lib/trpc';

// Optimistic writes on the same cache region are generation-stamped so an older
// mutation's rollback cannot stomp a newer mutation's optimistic value.
const MCP_MUTATION_KEY = 'agentProfiles:mcp';
const KILO_COMMAND_MUTATION_KEY = 'agentProfiles:kiloCommand';

function withMcpEnabled(
  profile: AgentProfileDetail,
  mcpServerId: string,
  enabled: boolean
): AgentProfileDetail {
  return {
    ...profile,
    mcpServers: profile.mcpServers.map(server =>
      server.id === mcpServerId ? { ...server, enabled } : server
    ),
  };
}

function withKiloCommandEnabled(
  profile: AgentProfileDetail,
  commandId: string,
  enabled: boolean
): AgentProfileDetail {
  return {
    ...profile,
    kiloCommands: profile.kiloCommands.map(command =>
      command.id === commandId ? { ...command, enabled } : command
    ),
  };
}

/**
 * Reorder the local kilo commands to match `orderedIds`. Ids the server no
 * longer has keep their relative position at the end, so a stale client list
 * can never drop a command from the cache.
 */
function withKiloCommandOrder(
  profile: AgentProfileDetail,
  orderedIds: readonly string[]
): AgentProfileDetail {
  const byId = new Map(profile.kiloCommands.map(command => [command.id, command]));
  const next = orderedIds.flatMap(id => {
    const command = byId.get(id);
    if (command === undefined) {
      return [];
    }
    byId.delete(id);
    return [command];
  });
  return { ...profile, kiloCommands: [...next, ...byId.values()] };
}

/**
 * The MCP server, agent, and kilo (slash) command mutations. Each carries the
 * hook's organization context, toasts a failed server call exactly once, and
 * invalidates the `agentProfiles` namespace so the list and detail queries
 * reconcile with server truth.
 *
 * The enabled toggles and the kilo-command reorder are optimistic: they snapshot
 * the detail cache in `onMutate`, roll back in `onError` (latest generation
 * only), and invalidate again in `onSettled` to reconcile.
 */
export function useAgentProfileSectionMutations(organizationId?: string) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const profilesFilter = trpc.agentProfiles.pathFilter();
  const detailFilter = trpc.agentProfiles.get.pathFilter();

  const invalidateProfiles = () => {
    void queryClient.invalidateQueries(profilesFilter);
  };
  const toastError = (error: { message: string }) => {
    toast.error(error.message);
  };
  const callbacks = {
    onSuccess: invalidateProfiles,
    onError: (error: { message: string }) => {
      toastError(error);
    },
  };

  const createMcp = useMutation(
    withOrganization(trpc.agentProfiles.createMcp.mutationOptions(callbacks), organizationId)
  );
  const updateMcp = useMutation(
    withOrganization(trpc.agentProfiles.updateMcp.mutationOptions(callbacks), organizationId)
  );
  const deleteMcp = useMutation(
    withOrganization(trpc.agentProfiles.deleteMcp.mutationOptions(callbacks), organizationId)
  );
  const createAgent = useMutation(
    withOrganization(trpc.agentProfiles.createAgent.mutationOptions(callbacks), organizationId)
  );
  const updateAgent = useMutation(
    withOrganization(trpc.agentProfiles.updateAgent.mutationOptions(callbacks), organizationId)
  );
  const deleteAgent = useMutation(
    withOrganization(trpc.agentProfiles.deleteAgent.mutationOptions(callbacks), organizationId)
  );
  const createKiloCommand = useMutation(
    withOrganization(
      trpc.agentProfiles.createKiloCommand.mutationOptions(callbacks),
      organizationId
    )
  );
  const updateKiloCommand = useMutation(
    withOrganization(
      trpc.agentProfiles.updateKiloCommand.mutationOptions(callbacks),
      organizationId
    )
  );
  const deleteKiloCommand = useMutation(
    withOrganization(
      trpc.agentProfiles.deleteKiloCommand.mutationOptions(callbacks),
      organizationId
    )
  );

  const setMcpEnabled = useMutation(
    withOrganization(
      trpc.agentProfiles.setMcpEnabled.mutationOptions({
        ...callbacks,
        onMutate: async variables => {
          await queryClient.cancelQueries({ queryKey: detailFilter.queryKey });
          const generation = nextMutationGeneration(MCP_MUTATION_KEY);
          const previous = queryClient.getQueriesData<AgentProfileDetail>({
            queryKey: detailFilter.queryKey,
          });
          queryClient.setQueriesData<AgentProfileDetail>({ queryKey: detailFilter.queryKey }, old =>
            old ? withMcpEnabled(old, variables.mcpServerId, variables.enabled) : old
          );
          return { generation, previous };
        },
        onError: (error, _variables, context) => {
          if (context && isLatestMutationGeneration(MCP_MUTATION_KEY, context.generation)) {
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

  const setKiloCommandEnabled = useMutation(
    withOrganization(
      trpc.agentProfiles.setKiloCommandEnabled.mutationOptions({
        ...callbacks,
        onMutate: async variables => {
          await queryClient.cancelQueries({ queryKey: detailFilter.queryKey });
          const generation = nextMutationGeneration(KILO_COMMAND_MUTATION_KEY);
          const previous = queryClient.getQueriesData<AgentProfileDetail>({
            queryKey: detailFilter.queryKey,
          });
          queryClient.setQueriesData<AgentProfileDetail>({ queryKey: detailFilter.queryKey }, old =>
            old ? withKiloCommandEnabled(old, variables.commandId, variables.enabled) : old
          );
          return { generation, previous };
        },
        onError: (error, _variables, context) => {
          if (
            context &&
            isLatestMutationGeneration(KILO_COMMAND_MUTATION_KEY, context.generation)
          ) {
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

  const reorderKiloCommands = useMutation(
    withOrganization(
      trpc.agentProfiles.reorderKiloCommands.mutationOptions({
        ...callbacks,
        onMutate: async variables => {
          await queryClient.cancelQueries({ queryKey: detailFilter.queryKey });
          const generation = nextMutationGeneration(KILO_COMMAND_MUTATION_KEY);
          const previous = queryClient.getQueriesData<AgentProfileDetail>({
            queryKey: detailFilter.queryKey,
          });
          queryClient.setQueriesData<AgentProfileDetail>({ queryKey: detailFilter.queryKey }, old =>
            old ? withKiloCommandOrder(old, variables.orderedIds) : old
          );
          return { generation, previous };
        },
        onError: (error, _variables, context) => {
          if (
            context &&
            isLatestMutationGeneration(KILO_COMMAND_MUTATION_KEY, context.generation)
          ) {
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

  return {
    createMcp,
    updateMcp,
    deleteMcp,
    setMcpEnabled,
    createAgent,
    updateAgent,
    deleteAgent,
    createKiloCommand,
    updateKiloCommand,
    deleteKiloCommand,
    setKiloCommandEnabled,
    reorderKiloCommands,
  };
}
