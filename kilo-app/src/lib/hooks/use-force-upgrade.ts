import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { APP_BUILD } from '@/lib/app-build';
import { useTRPC } from '@/lib/trpc';

export function useForceUpgrade() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const appState = useRef(AppState.currentState);

  const { data, isLoading } = useQuery(
    trpc.appConfig.getMinVersion.queryOptions(undefined, {
      staleTime: 60_000,
      retry: 1,
    })
  );

  // Refetch when app comes to foreground
  useEffect(() => {
    const subscription = AppState.addEventListener('change', nextAppState => {
      if (/inactive|background/.exec(appState.current) && nextAppState === 'active') {
        void queryClient.invalidateQueries({
          queryKey: trpc.appConfig.getMinVersion.queryKey(),
        });
      }
      appState.current = nextAppState;
    });
    return () => {
      subscription.remove();
    };
  }, [queryClient, trpc]);

  const blocked = data != null && APP_BUILD < data.minBuild;
  const otaForceUpdate = data?.otaForceUpdate ?? false;

  return { blocked, otaForceUpdate, isChecking: isLoading };
}
