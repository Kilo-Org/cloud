/* eslint-disable typescript-eslint/consistent-type-definitions -- AGENTS.md prefers type over interface */
import type { LocalAgentConnectedAgent } from '@/src/shared/local-agents/registry';
import type { LocalAgentEndpointStatus } from '@/src/shared/local-agents/status';

/*
 * Presentation state for the "Local agents" settings section. Kept pure so the
 * empty-state priority is testable without a browser: a missing native host is
 * only worth its setup hint while nothing is actually connected, and not at all
 * once a paired CLI's own row explains the state.
 */

/** How long a paired CLI that dropped reads as reconnecting before the section calls it unreachable. */
export const LOOPBACK_RECONNECT_GRACE_MS = 60_000;

export type LocalAgentsEmptyState =
  | 'none'
  | 'connected'
  | 'host_missing_not_installed'
  | 'host_missing_permission'
  | 'waiting';

export type LocalAgentsControllerGroup = {
  controllerId: string;
  transport: LocalAgentConnectedAgent['transport'];
  agents: LocalAgentConnectedAgent[];
};

export type LocalAgentsLoopbackReachability = 'connected' | 'reconnecting' | 'unreachable';

export type LocalAgentsLoopbackEndpoint = {
  address: string;
  endpointId: string;
  reachability: LocalAgentsLoopbackReachability;
};

export type LocalAgentsSettingsView = {
  controllerGroups: LocalAgentsControllerGroup[];
  emptyState: LocalAgentsEmptyState;
  enabled: boolean | undefined;
  loopbackEndpoints: LocalAgentsLoopbackEndpoint[];
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

/** A hub seen within the grace period is still coming back; one never seen, or seen long ago, is not. */
const reachabilityOf = (
  state: LocalAgentEndpointStatus['state'],
  lastConnectedAt: number | undefined,
  now: number
): LocalAgentsLoopbackReachability => {
  if (state.kind === 'connected') {
    return 'connected';
  }

  return lastConnectedAt !== undefined && now - lastConnectedAt < LOOPBACK_RECONNECT_GRACE_MS
    ? 'reconnecting'
    : 'unreachable';
};

export const deriveLocalAgentsSettingsView = ({
  agents,
  enabled,
  now,
  status,
}: {
  agents: LocalAgentConnectedAgent[];
  enabled: boolean | undefined;
  now: number;
  status: LocalAgentEndpointStatus[];
}): LocalAgentsSettingsView => {
  const controllerGroups = groupAgentsByController(agents);

  if (enabled !== true) {
    return { controllerGroups, emptyState: 'none', enabled, loopbackEndpoints: [] };
  }

  const loopbackEndpoints = status.flatMap(endpoint =>
    endpoint.transport === 'loopback'
      ? [
          {
            address: endpoint.address,
            endpointId: endpoint.endpointId,
            reachability: reachabilityOf(endpoint.state, endpoint.lastConnectedAt, now),
          },
        ]
      : []
  );
  const view = { controllerGroups, enabled, loopbackEndpoints };

  if (controllerGroups.length > 0) {
    return { ...view, emptyState: 'none' };
  }

  // A live connection outranks a failed native endpoint.
  if (status.some(endpoint => endpoint.state.kind === 'connected')) {
    return { ...view, emptyState: 'connected' };
  }

  // A paired CLI's row already says why nothing is connected; the native-host hint would point elsewhere.
  if (loopbackEndpoints.length > 0) {
    return { ...view, emptyState: 'none' };
  }

  const hostMissing = new Set(
    status.flatMap(endpoint =>
      endpoint.state.kind === 'host_missing' ? [endpoint.state.reason] : []
    )
  );

  if (hostMissing.has('not_installed')) {
    return { ...view, emptyState: 'host_missing_not_installed' };
  }

  if (hostMissing.has('permission_denied')) {
    return { ...view, emptyState: 'host_missing_permission' };
  }

  return { ...view, emptyState: 'waiting' };
};
