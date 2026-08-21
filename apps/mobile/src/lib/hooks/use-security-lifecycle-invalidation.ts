import * as Notifications from 'expo-notifications';
import { onlineManager, type QueryClient, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { AppState } from 'react-native';

import {
  invalidateSecurityAgentCommandObserver,
  invalidateSecurityQueryScopes,
} from '@/lib/hooks/use-security-agent-commands';
import { parseNotificationData } from '@/lib/notifications';
import { reconcileFirstPage } from '@/lib/query/infinite-retention';
import { scheduleCacheMaintenance } from '@/lib/query/schedule-cache-maintenance';
import { useTRPC } from '@/lib/trpc';

type SecurityLifecycleInvalidationDeps = {
  trpc: ReturnType<typeof useTRPC>;
  queryClient: QueryClient;
};

/**
 * Invalidates the findings list, finding details, and command-status queries
 * for one scope after a `security_lifecycle` push changed that scope's state.
 * Reuses `invalidateSecurityQueryScopes` for the findings/finding-details
 * scope keys, then adds the command-status invalidation on top.
 */
export function invalidateSecurityLifecycleScope(
  deps: SecurityLifecycleInvalidationDeps,
  scope: string
): void {
  const { trpc, queryClient } = deps;

  invalidateSecurityQueryScopes({ trpc, queryClient }, scope, ['findings', 'findingDetails']);
  invalidateSecurityAgentCommandObserver(queryClient, trpc, scope);
}

/**
 * Invalidates the findings, finding-details, and command-status families for
 * every scope (personal and all organizations) with no scope in hand. Used on
 * AppState return to `active` and on React Query reconnect: a missed push must
 * not leave findings stale, so the whole family refetches from the server.
 */
export function invalidateAllSecurityLifecycleScopes(
  deps: SecurityLifecycleInvalidationDeps
): void {
  const { trpc, queryClient } = deps;

  scheduleCacheMaintenance(() => {
    reconcileFirstPage(queryClient, trpc.securityAgent.listFindings.queryKey());
  });
  void queryClient.invalidateQueries({ queryKey: trpc.securityAgent.getFinding.queryKey() });
  void queryClient.invalidateQueries({
    queryKey: trpc.securityAgent.getCommandStatuses.queryKey(),
  });
  void queryClient.invalidateQueries({
    queryKey: trpc.securityAgent.listActiveCommands.queryKey(),
  });

  scheduleCacheMaintenance(() => {
    reconcileFirstPage(queryClient, trpc.organizations.securityAgent.listFindings.queryKey());
  });
  void queryClient.invalidateQueries({
    queryKey: trpc.organizations.securityAgent.getFinding.queryKey(),
  });
  void queryClient.invalidateQueries({
    queryKey: trpc.organizations.securityAgent.getCommandStatuses.queryKey(),
  });
  void queryClient.invalidateQueries({
    queryKey: trpc.organizations.securityAgent.listActiveCommands.queryKey(),
  });
}

/**
 * Registers the three recovery sources and returns a single cleanup function:
 * foreground push receipt (scope-specific), AppState return to `active`, and
 * React Query reconnect (both family-wide). The notification data is
 * Zod-parsed first, so an old or unknown event value is dropped without any
 * invalidation.
 */
export function subscribeToSecurityLifecycleInvalidation(
  deps: SecurityLifecycleInvalidationDeps
): () => void {
  const notificationSubscription = Notifications.addNotificationReceivedListener(notification => {
    const data = parseNotificationData(notification.request.content.data);
    if (data?.type !== 'security_lifecycle') {
      return;
    }
    invalidateSecurityLifecycleScope(deps, data.scope);
  });

  const appStateSubscription = AppState.addEventListener('change', nextState => {
    if (nextState === 'active') {
      invalidateAllSecurityLifecycleScopes(deps);
    }
  });

  const unsubscribeOnline = onlineManager.subscribe(online => {
    if (online) {
      invalidateAllSecurityLifecycleScopes(deps);
    }
  });

  return () => {
    notificationSubscription.remove();
    appStateSubscription.remove();
    unsubscribeOnline();
  };
}

/**
 * Mounted by the authed app layout. Owns the query client that
 * `notifications.ts` (the display/tap handler) does not have.
 */
export function useSecurityLifecycleInvalidation(): void {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  useEffect(
    () => subscribeToSecurityLifecycleInvalidation({ trpc, queryClient }),
    [trpc, queryClient]
  );
}
