import {
  isActiveSecurityCommand,
  isPersonalSecurityScope,
} from '@kilocode/app-shared/security-agent';
import { useQuery } from '@tanstack/react-query';

import { type SecurityCommand } from '@/lib/security-agent';
import { useTRPC } from '@/lib/trpc';

// The command observer already polls a tracked sync every 3 s; the dashboard
// reads the same list, so it shares that cadence instead of inventing another.
const SYNC_POLL_INTERVAL_MS = 3000;

function hasActiveSync(commands: readonly SecurityCommand[] | undefined): boolean {
  return (commands ?? []).some(
    command => command.commandType === 'sync' && isActiveSecurityCommand(command)
  );
}

/**
 * Whether the server still holds a sync command for this scope, and keeps that
 * read polling while `watching`.
 *
 * A sync outlives the request that started it: the 202 means the command was
 * accepted, not finished, and a second submit while it runs is answered with
 * the ledger's in-progress conflict. `listActiveCommands` is the only read that
 * reports the run itself, so the dashboard's running state and its completion
 * refresh come from here. It shares the command observer's query key (and its
 * invalidation of the dashboard queries on a terminal command), so the two
 * observers cost one request.
 *
 * `updatedAt` is the last successful read's timestamp: a caller that starts
 * watching at time T can tell a fresh, empty answer from a cached one that
 * predates its own subject. `readFailedAt` is the last failed read's: a poll
 * that errors never advances `updatedAt`, so a caller must be able to tell
 * "nothing to report" from "nothing can be read".
 */
export function useSecurityAgentSyncRunning(scope: string, watching: boolean) {
  const trpc = useTRPC();
  const isPersonal = isPersonalSecurityScope(scope);
  const refetchInterval = (query: { state: { data?: readonly SecurityCommand[] } }) =>
    watching || hasActiveSync(query.state.data) ? SYNC_POLL_INTERVAL_MS : false;
  // Personal and org procedures resolve to nominally distinct option types, so
  // both stay mounted and `enabled` picks the active one (see use-security-agent.ts).
  const personal = useQuery({
    ...trpc.securityAgent.listActiveCommands.queryOptions(),
    enabled: isPersonal,
    refetchInterval,
  });
  const organization = useQuery({
    ...trpc.organizations.securityAgent.listActiveCommands.queryOptions({
      organizationId: scope,
    }),
    enabled: !isPersonal,
    refetchInterval,
  });
  const query = isPersonal ? personal : organization;
  return {
    syncRunning: hasActiveSync(query.data),
    updatedAt: query.dataUpdatedAt,
    // A failed read cannot tell a finished run from a running one, so a caller
    // waiting for its own submit must not treat the silence as progress.
    readFailedAt: query.errorUpdatedAt,
  };
}
