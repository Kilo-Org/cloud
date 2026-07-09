import { useEffect, useRef } from 'react';
import { type QueryClient, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner-native';

import { isPersonalSecurityScope, type SecurityCommand } from '@/lib/security-agent';
import {
  getSecurityCommandFailureMessage,
  getSecurityCommandInvalidationScopes,
  isActiveSecurityCommand,
  mergeTrackedCommandIds,
  securityCommandIdsKey,
  type SecurityQueryScope,
} from '@/lib/security-agent-commands';
import { useTRPC } from '@/lib/trpc';

const COMMAND_POLL_INTERVAL_MS = 3000;
const EMPTY_COMMANDS: readonly SecurityCommand[] = [];

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

// Registers a freshly created command for background tracking (polling +
// invalidation + toast) by the observer for the given scope. Mutation hooks
// call this from their `onSuccess` once a command id comes back.
export function trackSecurityAgentCommand(
  queryClient: QueryClient,
  scope: string,
  commandId: string
): void {
  queryClient.setQueryData<string[]>(securityCommandIdsKey(scope), old =>
    mergeTrackedCommandIds(old ?? [], [commandId])
  );
}

// Invalidates only the query families mapped to `scopes`, branching on
// personal vs. organization procedures (their input shapes are nominally
// distinct, so each branch stays fully separate rather than sharing a
// polymorphic "agent" reference).
function invalidateSecurityQueryScopes(
  deps: { trpc: ReturnType<typeof useTRPC>; queryClient: QueryClient },
  scope: string,
  scopes: readonly SecurityQueryScope[]
): void {
  const { trpc, queryClient } = deps;
  const scopeSet = new Set(scopes);

  if (isPersonalSecurityScope(scope)) {
    const agent = trpc.securityAgent;
    if (scopeSet.has('findings')) {
      void queryClient.invalidateQueries({ queryKey: agent.listFindings.queryKey() });
    }
    if (scopeSet.has('findingDetails')) {
      void queryClient.invalidateQueries({ queryKey: agent.getFinding.queryKey() });
    }
    if (scopeSet.has('analysis')) {
      void queryClient.invalidateQueries({ queryKey: agent.getAnalysis.queryKey() });
    }
    if (scopeSet.has('stats')) {
      void queryClient.invalidateQueries({ queryKey: agent.getStats.queryKey() });
    }
    if (scopeSet.has('dashboardStats')) {
      void queryClient.invalidateQueries({ queryKey: agent.getDashboardStats.queryKey() });
    }
    if (scopeSet.has('lastSyncTime')) {
      void queryClient.invalidateQueries({ queryKey: agent.getLastSyncTime.queryKey() });
    }
    if (scopeSet.has('repositories')) {
      void queryClient.invalidateQueries({ queryKey: agent.getRepositories.queryKey() });
    }
    if (scopeSet.has('permissionStatus')) {
      void queryClient.invalidateQueries({ queryKey: agent.getPermissionStatus.queryKey() });
    }
    return;
  }

  const agent = trpc.organizations.securityAgent;
  const ownerInput = { organizationId: scope };
  if (scopeSet.has('findings')) {
    void queryClient.invalidateQueries({ queryKey: agent.listFindings.queryKey(ownerInput) });
  }
  if (scopeSet.has('findingDetails')) {
    void queryClient.invalidateQueries({ queryKey: agent.getFinding.queryKey(ownerInput) });
  }
  if (scopeSet.has('analysis')) {
    void queryClient.invalidateQueries({ queryKey: agent.getAnalysis.queryKey(ownerInput) });
  }
  if (scopeSet.has('stats')) {
    void queryClient.invalidateQueries({ queryKey: agent.getStats.queryKey(ownerInput) });
  }
  if (scopeSet.has('dashboardStats')) {
    void queryClient.invalidateQueries({ queryKey: agent.getDashboardStats.queryKey(ownerInput) });
  }
  if (scopeSet.has('lastSyncTime')) {
    void queryClient.invalidateQueries({ queryKey: agent.getLastSyncTime.queryKey(ownerInput) });
  }
  if (scopeSet.has('repositories')) {
    void queryClient.invalidateQueries({ queryKey: agent.getRepositories.queryKey(ownerInput) });
  }
  if (scopeSet.has('permissionStatus')) {
    void queryClient.invalidateQueries({
      queryKey: agent.getPermissionStatus.queryKey(ownerInput),
    });
  }
}

function successMessageForCommand(command: SecurityCommand): string {
  if (command.commandType === 'dismiss_finding') {
    return command.status === 'no_op' ? 'Finding already dismissed' : 'Finding dismissed';
  }
  if (command.commandType === 'apply_auto_remediation') {
    return command.status === 'no_op'
      ? 'No existing findings queued'
      : 'Existing remediations queued';
  }
  if (command.commandType === 'start_analysis') {
    return 'Analysis complete';
  }
  return 'Sync complete';
}

// Polls for and reconciles background Security Agent commands (sync,
// dismiss, analysis, remediation) for one scope ('personal' or an
// organization id): recovers in-flight command ids via `listActiveCommands`,
// polls each tracked id via `getCommandStatus` every 3s while active,
// invalidates the affected query families on terminal state, shows one
// toast per terminal id, then drops it from the tracked list.
export function useSecurityAgentCommands(scope: string): void {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const isPersonal = isPersonalSecurityScope(scope);
  const trackedIdsKey = securityCommandIdsKey(scope);
  const processedTerminalIdsRef = useRef<Set<string>>(new Set());

  const personalActive = useQuery({
    ...trpc.securityAgent.listActiveCommands.queryOptions(),
    enabled: isPersonal,
    refetchInterval: query =>
      query.state.data && query.state.data.length > 0 ? COMMAND_POLL_INTERVAL_MS : false,
  });
  const orgActive = useQuery({
    ...trpc.organizations.securityAgent.listActiveCommands.queryOptions({
      organizationId: scope,
    }),
    enabled: !isPersonal,
    refetchInterval: query =>
      query.state.data && query.state.data.length > 0 ? COMMAND_POLL_INTERVAL_MS : false,
  });
  const recoveredCommands = (isPersonal ? personalActive.data : orgActive.data) ?? EMPTY_COMMANDS;

  // A local-only cache slot for the tracked id list — read reactively via
  // `useQuery` so writes from `trackSecurityAgentCommand` (called by
  // mutation hooks elsewhere) trigger a re-render here too.
  const { data: trackedIds } = useQuery({
    queryKey: trackedIdsKey,
    queryFn: () => queryClient.getQueryData<string[]>(trackedIdsKey) ?? [],
    initialData: () => queryClient.getQueryData<string[]>(trackedIdsKey) ?? [],
    staleTime: Infinity,
    enabled: false,
  });

  useEffect(() => {
    // `listActiveCommands` can lag one poll behind `getCommandStatus` and
    // still report an already-terminal command as active. Filtering those
    // ids here stops us from re-adding a command the terminal-processing
    // effect below already toasted and dropped — otherwise its
    // `processedTerminalIdsRef` gate would keep that effect from ever
    // removing it again, stranding the id (and its idle query) in
    // `trackedIds` for the rest of the session.
    const merged = mergeTrackedCommandIds(
      recoveredCommands
        .map(command => command.id)
        .filter(id => !processedTerminalIdsRef.current.has(id)),
      trackedIds
    );
    if (!sameIds(merged, trackedIds)) {
      queryClient.setQueryData(trackedIdsKey, merged);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- recoveredCommands is derived per render; comparing by content via sameIds avoids the loop
  }, [recoveredCommands, trackedIds, queryClient, trackedIdsKey]);

  const commandStatusQueries = useQueries({
    queries: trackedIds.map(commandId => ({
      ...(isPersonal
        ? trpc.securityAgent.getCommandStatus.queryOptions({ commandId })
        : trpc.organizations.securityAgent.getCommandStatus.queryOptions({
            organizationId: scope,
            commandId,
          })),
      refetchInterval: (query: { state: { data?: SecurityCommand } }) =>
        query.state.data && isActiveSecurityCommand(query.state.data)
          ? COMMAND_POLL_INTERVAL_MS
          : false,
    })),
  });

  useEffect(() => {
    const unavailableIds = commandStatusQueries.flatMap((query, index) => {
      const id = trackedIds[index];
      return query.error?.data?.code === 'NOT_FOUND' && id ? [id] : [];
    });
    const terminalCommands = commandStatusQueries
      .map(query => query.data)
      .filter(
        (command): command is SecurityCommand =>
          command !== undefined &&
          !isActiveSecurityCommand(command) &&
          !processedTerminalIdsRef.current.has(command.id)
      );
    if (terminalCommands.length === 0 && unavailableIds.length === 0) {
      return;
    }

    if (unavailableIds.length > 0) {
      toast.error('A queued action could no longer be tracked. Refresh to see the latest state.');
      for (const id of unavailableIds) {
        processedTerminalIdsRef.current.add(id);
      }
    }

    for (const command of terminalCommands) {
      processedTerminalIdsRef.current.add(command.id);
      if (command.status === 'failed') {
        toast.error(getSecurityCommandFailureMessage(command));
      } else {
        toast.success(successMessageForCommand(command));
      }
      invalidateSecurityQueryScopes(
        { trpc, queryClient },
        scope,
        getSecurityCommandInvalidationScopes(command.commandType)
      );
    }

    const terminalIds = new Set(terminalCommands.map(command => command.id));
    const completedIds = new Set([...terminalIds, ...unavailableIds]);
    queryClient.setQueryData(
      trackedIdsKey,
      trackedIds.filter(id => !completedIds.has(id))
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- trpc/queryClient are stable; trackedIds/scope drive the effect body directly
  }, [commandStatusQueries, trackedIds, scope, trackedIdsKey]);
}
