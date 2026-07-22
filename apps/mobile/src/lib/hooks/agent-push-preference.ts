import { type QueryClient } from '@tanstack/react-query';

/**
 * Pure logic for the "Agent notifications" settings row (S4).
 *
 * The preference is per-user, cross-device, and server-resolved: a successful
 * query with no row means enabled (default ON), and the switch is editable
 * whenever the preference query has resolved — independent of this device's
 * OS permission or push-token registration (those are communicated by the
 * card's existing permission + Chat-registration rows).
 */
export const DEFAULT_AGENT_PUSH_ENABLED = true as const;

type AgentPushPreferenceSnapshot = Readonly<{ agentPushEnabled: boolean }>;

/** Can the user flip the switch from the rendered row right now? */
export function deriveAgentPushEditable(args: { hasData: boolean; isPending: boolean }): boolean {
  return args.hasData && !args.isPending;
}

/** Read the optimistic value currently in cache; falls back to the default. */
export function readAgentPushPreference(
  queryClient: Pick<QueryClient, 'getQueryData'>,
  queryKey: readonly unknown[]
): boolean {
  const data = queryClient.getQueryData(queryKey) as AgentPushPreferenceSnapshot | undefined;
  return data?.agentPushEnabled ?? DEFAULT_AGENT_PUSH_ENABLED;
}

/**
 * Apply the optimistic flip. Returns the previous snapshot for rollback.
 * Mirrors the existing registerToken / unregisterToken onMutate shape so the
 * row's `useMutation` can spread the result into its context.
 */
export async function applyAgentPushOptimistic(args: {
  queryClient: Pick<QueryClient, 'cancelQueries' | 'getQueryData' | 'setQueryData'>;
  queryKey: readonly unknown[];
  next: boolean;
}): Promise<{ previous: AgentPushPreferenceSnapshot | undefined }> {
  await args.queryClient.cancelQueries({ queryKey: args.queryKey });
  const previous = args.queryClient.getQueryData(args.queryKey) as
    | AgentPushPreferenceSnapshot
    | undefined;
  args.queryClient.setQueryData(args.queryKey, { agentPushEnabled: args.next });
  return { previous };
}

/**
 * Restore the previous snapshot. When there was none, remove the cache entry
 * so the next read falls back to the default (no row ⇒ enabled) instead of
 * leaving the optimistic value in place.
 */
export function rollbackAgentPushOptimistic(args: {
  queryClient: Pick<QueryClient, 'setQueryData' | 'removeQueries'>;
  queryKey: readonly unknown[];
  previous: AgentPushPreferenceSnapshot | undefined;
}): void {
  if (args.previous) {
    args.queryClient.setQueryData(args.queryKey, args.previous);
    return;
  }
  args.queryClient.removeQueries({ queryKey: args.queryKey });
}
