import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PlugZap, RefreshCcw, ShieldAlert } from 'lucide-react-native';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, type AppStateStatus, Platform, View } from 'react-native';
import { toast } from 'sonner-native';

import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { openAuthorizationAndWaitForReturn } from '@/lib/pr-review/connect-gate-platform';
import { useTRPC } from '@/lib/trpc';

type PrReviewConnectGateProps = {
  readonly children: ReactNode;
};

/**
 * Wraps every PR-review surface. The user's GitHub identity (separate from
 * a per-org GitHub App installation) is required to post review comments
 * via the mobile app — without it, every mutation would 401 in the same
 * way. The gate is the single place that handles:
 *
 *  - happy: connected → render children
 *  - retryable: getUserAuthorization fails → QueryError + Retry
 *  - empty: not connected / revoked → EmptyState CTA
 *  - non-retryable: structurally n/a (this is a configuration gate, not a
 *    transient server failure).
 *
 * The CTA calls `githubApps.connectUserAuthorization` and opens the
 * returned URL with the platform-appropriate browser launcher (iOS native
 * auth session that resolves on sheet close; Android custom tab that
 * resolves on app-foreground via AppState). Cancellation on either
 * platform simply leaves the gate showing — there's nothing to roll
 * back because the auth flow is server-driven.
 */
export function PrReviewConnectGate({ children }: PrReviewConnectGateProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const colors = useThemeColors();
  const authorization = useQuery(trpc.githubApps.getUserAuthorization.queryOptions());
  const connect = useMutation(
    trpc.githubApps.connectUserAuthorization.mutationOptions({
      onError: error => {
        toast.error(error.message);
      },
    })
  );

  // Track the in-flight launch so a stale AppState 'active' transition
  // (from the user backgrounding the app before tapping Connect) doesn't
  // trigger a refetch on its own.
  const launchedAt = useRef<number | null>(null);
  const [connecting, setConnecting] = useState(false);

  // iOS: openAuthSessionAsync already resolves on sheet close, so we await
  // it and refetch right there. Android: openBrowserAsync is fire-and-
  // forget, so we listen for AppState returning to 'active' and refetch
  // then. Same split as use-device-auth.ts.
  useEffect(() => {
    if (Platform.OS !== 'android') {
      return undefined;
    }
    const handleChange = (nextState: AppStateStatus) => {
      if (nextState !== 'active') {
        return;
      }
      if (launchedAt.current === null) {
        return;
      }
      launchedAt.current = null;
      void authorization.refetch();
    };
    const subscription = AppState.addEventListener('change', handleChange);
    return () => {
      subscription.remove();
    };
  }, [authorization]);

  const handleConnect = async () => {
    setConnecting(true);
    try {
      const result = await connect.mutateAsync();
      launchedAt.current = Date.now();
      const trigger = await openAuthorizationAndWaitForReturn(Platform.OS, result.authorizationUrl);
      if (trigger === 'sheet-close') {
        // iOS: refetch immediately. Clear the launch sentinel so the
        // AppState handler (if it ever fires) doesn't double-refetch.
        launchedAt.current = null;
        await authorization.refetch();
        await queryClient.invalidateQueries({
          queryKey: trpc.githubApps.getUserAuthorization.queryKey(),
        });
      }
      // Android: refetch is handled by the AppState listener when the app
      // returns to foreground. `openBrowserAsync` resolves as soon as the
      // browser is launched, so we must NOT clear the sentinel here — the
      // foreground handler clears it once it has consumed it.
    } catch {
      // mutateAsync already toasted; the openAuthorizationAndWaitForReturn
      // rejection means the browser failed to open — clear the sentinel so
      // a later unrelated foreground doesn't trigger a stray refetch, and
      // keep the gate showing.
      launchedAt.current = null;
    } finally {
      setConnecting(false);
    }
  };

  if (authorization.isError) {
    return (
      <View className="flex-1 bg-background">
        <QueryError
          variant="server"
          title="Could not check GitHub connection"
          message="Sign-in status is unavailable until this loads."
          onRetry={() => {
            void authorization.refetch();
          }}
          isRetrying={authorization.isFetching}
        />
      </View>
    );
  }

  if (authorization.isLoading) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator size="small" color={colors.mutedForeground} />
      </View>
    );
  }

  if (!authorization.data?.connected) {
    const revoked = authorization.data?.revoked === true;
    return (
      <View className="flex-1 bg-background">
        <EmptyState
          icon={revoked ? ShieldAlert : PlugZap}
          title={revoked ? 'Reconnect GitHub' : 'Connect GitHub'}
          description={
            revoked
              ? 'Your GitHub connection was revoked. Reconnect to keep reviewing pull requests on mobile.'
              : 'Connect your GitHub account to review pull requests on mobile.'
          }
          action={
            <Button
              className="mt-3 w-full flex-row gap-2"
              disabled={connecting}
              onPress={() => {
                void handleConnect();
              }}
            >
              {connecting ? (
                <ActivityIndicator size="small" color={colors.primaryForeground} />
              ) : (
                <RefreshCcw size={16} color={colors.primaryForeground} />
              )}
              <Text>{revoked ? 'Reconnect GitHub' : 'Connect GitHub'}</Text>
            </Button>
          }
        />
      </View>
    );
  }

  return <>{children}</>;
}
