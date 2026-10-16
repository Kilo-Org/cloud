import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  listAgents,
  type ListAgentsResult,
  type ListAgentsTarget,
} from '@kilocode/cloud-agent-sdk/list-agents';

import { useUserWebConnection } from '@/components/agents/user-web-connection-provider';
import { cliCommandUnavailableError } from '@/lib/hooks/cli-command-unavailable-error';

export type CliAgent = { slug: string; name: string; description?: string };

const NO_AGENTS: CliAgent[] = [];

/**
 * Read the agents a CLI can run, including the project agents it loads from
 * `.kilo/agents`, for a computer before a session exists (scoped to the
 * selected launch folder) or for a remote session (scoped to its directory).
 *
 * Only the retryable `transport` outcome rejects, so React Query owns the
 * retry and the app reports it once. An old CLI (`unsupported`) or a bad body
 * (`invalid`) resolves to no agents: the picker then shows what it showed
 * before this command existed.
 */
export function useCliAgents(target: ListAgentsTarget | null): CliAgent[] {
  const connection = useUserWebConnection();
  const { data } = useQuery<ListAgentsResult>({
    queryKey: ['cli-agents', target],
    queryFn: async () => {
      // `enabled` guarantees a target; the guard narrows it for the SDK call.
      if (target === null) {
        return { ok: false, reason: 'unsupported' as const };
      }
      const result = await listAgents(connection, target);
      if (!result.ok && result.reason === 'transport') {
        throw cliCommandUnavailableError('list_agents', 'agent list unavailable', result.cause);
      }
      return result;
    },
    enabled: target !== null,
    retry: 1,
    staleTime: 30_000,
  });

  const agents = useMemo(
    () =>
      data?.ok === true
        ? data.agents.map(agent => ({
            slug: agent.name,
            name: agent.displayName ?? agent.name,
            ...(agent.description ? { description: agent.description } : {}),
          }))
        : NO_AGENTS,
    [data]
  );
  return target === null ? NO_AGENTS : agents;
}
