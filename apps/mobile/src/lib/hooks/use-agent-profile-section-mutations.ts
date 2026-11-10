import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner-native';

import { withOrganization } from '@/lib/hooks/agent-profile-mutation-helpers';
import {
  type AgentProfileKiloCommandRow,
  type AgentProfileMcpServerRow,
} from '@/lib/hooks/agent-profile-types';
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
  servers: AgentProfileMcpServerRow[],
  mcpServerId: string,
  enabled: boolean
): AgentProfileMcpServerRow[] {
  return servers.map(server => (server.id === mcpServerId ? { ...server, enabled } : server));
}

function withKiloCommandEnabled(
  commands: AgentProfileKiloCommandRow[],
  commandId: string,
  enabled: boolean
): AgentProfileKiloCommandRow[] {
  return commands.map(command => (command.id === commandId ? { ...command, enabled } : command));
}

/**
 * Reorder the local kilo commands to match `orderedIds`. Ids the server no
 * longer has keep their relative position at the end, so a stale client list
 * can never drop a command from the cache.
 */
function withKiloCommandOrder(
  commands: readonly AgentProfileKiloCommandRow[],
  orderedIds: readonly string[]
): AgentProfileKiloCommandRow[] {
  const byId = new Map(commands.map(command => [command.id, command]));
  const next = orderedIds.flatMap(id => {
    const command = byId.get(id);
    if (command === undefined) {
      return [];
    }
    byId.delete(id);
    return [command];
  });
  return [...next, ...byId.values()];
}

/**
 * The MCP server, agent, and kilo (slash) command mutations. Each carries the
 * hook's organization context, toasts a failed server call exactly once, and
 * invalidates the `agentProfiles` namespace so the list and section queries
 * reconcile with server truth.
 *
 * The enabled toggles and the kilo-command reorder are optimistic: they
 * snapshot the section's own list in `onMutate`, roll back in `onError` (latest
 * generation only), and invalidate again in `onSettled` to reconcile. They
 * write the section query the screen renders, not the whole-profile read, so
 * the control moves before the refetch lands.
 */
export function useAgentProfileSectionMutations(organizationId?: string) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const profilesFilter = trpc.agentProfiles.pathFilter();

  const invalidateProfiles = () => {
    void queryClient.invalidateQueries(profilesFilter);
  };
  const toastError = (error: { message: string }) => {
    toast.error(error.message);
  };
  // `networkMode: 'always'` keeps a section save settling while the online
  // manager is offline (NetInfo can misreport while the backend is reachable):
  // the request either succeeds or fails fast, so `isPending` can never stick.
  const callbacks = {
    networkMode: 'always' as const,
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
          const serversFilter = trpc.agentProfiles.mcpServers.queryFilter({
            profileId: variables.profileId,
            organizationId,
          });
          await queryClient.cancelQueries(serversFilter);
          const generation = nextMutationGeneration(MCP_MUTATION_KEY);
          const previous = queryClient.getQueriesData<AgentProfileMcpServerRow[]>(serversFilter);
          queryClient.setQueriesData<AgentProfileMcpServerRow[]>(serversFilter, old =>
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
          const commandsFilter = trpc.agentProfiles.kiloCommands.queryFilter({
            profileId: variables.profileId,
            organizationId,
          });
          await queryClient.cancelQueries(commandsFilter);
          const generation = nextMutationGeneration(KILO_COMMAND_MUTATION_KEY);
          const previous = queryClient.getQueriesData<AgentProfileKiloCommandRow[]>(commandsFilter);
          queryClient.setQueriesData<AgentProfileKiloCommandRow[]>(commandsFilter, old =>
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
          const commandsFilter = trpc.agentProfiles.kiloCommands.queryFilter({
            profileId: variables.profileId,
            organizationId,
          });
          await queryClient.cancelQueries(commandsFilter);
          const generation = nextMutationGeneration(KILO_COMMAND_MUTATION_KEY);
          const previous = queryClient.getQueriesData<AgentProfileKiloCommandRow[]>(commandsFilter);
          queryClient.setQueriesData<AgentProfileKiloCommandRow[]>(commandsFilter, old =>
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
