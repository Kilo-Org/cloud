import type { LocalAgentConnectedAgent } from '@/src/shared/local-agents/registry';
import type { LocalAgentEndpointStatus } from '@/src/shared/local-agents/status';

/*
 * Presentation state for the "Local agents" settings section. Kept pure so the
 * empty-state priority is testable without a browser: a missing native host is
 * only worth its setup hint while nothing is actually connected.
 */

export type LocalAgentsEmptyState = 'none' | 'host_missing' | 'idle' | 'waiting';

export type LocalAgentsControllerGroup = {
  controllerId: string;
  transport: LocalAgentConnectedAgent['transport'];
  agents: LocalAgentConnectedAgent[];
};

export type LocalAgentsSettingsView = {
  controllerGroups: LocalAgentsControllerGroup[];
  emptyState: LocalAgentsEmptyState;
  enabled: boolean | undefined;
};

export const groupAgentsByController = (
  agents: LocalAgentConnectedAgent[]
): LocalAgentsControllerGroup[] => {
  const groups = new Map<string, LocalAgentsControllerGroup>();

  for (const agent of agents) {
    const existing = groups.get(agent.controllerId);

    if (existing === undefined) {
      groups.set(agent.controllerId, {
        agents: [agent],
        controllerId: agent.controllerId,
        transport: agent.transport,
      });
    } else {
      existing.agents.push(agent);
    }
  }

  return [...groups.values()];
};

export const deriveLocalAgentsSettingsView = ({
  agents,
  enabled,
  status,
}: {
  agents: LocalAgentConnectedAgent[];
  enabled: boolean | undefined;
  status: LocalAgentEndpointStatus[];
}): LocalAgentsSettingsView => {
  const controllerGroups = groupAgentsByController(agents);

  if (enabled !== true) {
    return { controllerGroups, emptyState: 'none', enabled };
  }

  if (controllerGroups.length > 0) {
    return { controllerGroups, emptyState: 'none', enabled };
  }

  if (status.some(endpoint => endpoint.state.kind === 'host_missing')) {
    return { controllerGroups, emptyState: 'host_missing', enabled };
  }

  if (status.some(endpoint => endpoint.state.kind === 'connected')) {
    return { controllerGroups, emptyState: 'idle', enabled };
  }

  return { controllerGroups, emptyState: 'waiting', enabled };
};
