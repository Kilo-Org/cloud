import { storage } from '#imports';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentWorkflow } from '@/src/shared/agent-workflows';
import {
  AGENT_WORKFLOWS_STORAGE_KEY,
  loadAgentWorkflows,
} from '@/src/shared/agent-workflows-storage';
import { createLatestOnlyRefresh } from './latest-only-refresh';

const INITIAL_LOAD_RETRY_MS = 1000;

const waitMs = (ms: number): Promise<void> =>
  // eslint-disable-next-line promise/avoid-new -- timer bridge for initial-load retry
  new Promise(resolve => {
    setTimeout(resolve, ms);
  });

export interface UseAgentWorkflowsResult {
  readonly workflows: AgentWorkflow[];
  readonly isLoaded: boolean;
  readonly loadError: boolean;
  readonly reload: () => void;
}

export const useAgentWorkflows = (): UseAgentWorkflowsResult => {
  const [workflows, setWorkflows] = useState<AgentWorkflow[]>([]);
  const [isLoaded, setIsLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const refreshControlRef = useRef(createLatestOnlyRefresh());
  const initialRetryUsedRef = useRef(false);

  const refresh = useCallback(async (): Promise<'applied' | 'failed' | 'stale'> => {
    const result = await refreshControlRef.current.run(async () => {
      const nextWorkflows = await loadAgentWorkflows(storage);
      return nextWorkflows;
    });

    if (result.status === 'stale') {
      return 'stale';
    }

    if (result.status === 'failed') {
      return 'failed';
    }

    setWorkflows(result.value);
    setLoadError(false);
    setIsLoaded(true);
    return 'applied';
  }, []);

  const refreshWithFailureHandling = useCallback(
    async ({ isInitialLoad }: { isInitialLoad: boolean }): Promise<void> => {
      const outcome = await refresh();

      if (outcome === 'applied' || outcome === 'stale') {
        return;
      }

      if (isInitialLoad && !initialRetryUsedRef.current) {
        initialRetryUsedRef.current = true;
        await waitMs(INITIAL_LOAD_RETRY_MS);
        const retryOutcome = await refresh();
        if (retryOutcome === 'applied' || retryOutcome === 'stale') {
          return;
        }
      }

      setLoadError(true);
      setIsLoaded(true);
    },
    [refresh]
  );

  const reload = useCallback(() => {
    setIsLoaded(false);
    setLoadError(false);
    void refreshWithFailureHandling({ isInitialLoad: false });
  }, [refreshWithFailureHandling]);

  useEffect(() => {
    void refreshWithFailureHandling({ isInitialLoad: true });

    const unwatch = storage.watch(AGENT_WORKFLOWS_STORAGE_KEY, () => {
      void refreshWithFailureHandling({ isInitialLoad: false });
    });

    return () => {
      unwatch();
    };
  }, [refreshWithFailureHandling]);

  return {
    isLoaded,
    loadError,
    reload,
    workflows,
  };
};
