import { storage } from '#imports';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentMemory, PendingAgentMemoryDraft } from '@/src/shared/agent-memories';
import {
  AGENT_MEMORIES_STORAGE_KEY,
  PENDING_AGENT_MEMORY_DRAFT_STORAGE_KEY,
  loadAgentMemories,
  loadPendingAgentMemoryDraft,
} from '@/src/shared/agent-memories-storage';
import { createLatestOnlyRefresh } from './latest-only-refresh';

const INITIAL_LOAD_RETRY_MS = 1000;

const waitMs = (ms: number): Promise<void> =>
  // eslint-disable-next-line promise/avoid-new -- timer bridge for initial-load retry
  new Promise(resolve => {
    setTimeout(resolve, ms);
  });

export interface UseAgentMemoriesResult {
  readonly memories: AgentMemory[];
  readonly pendingDraft: PendingAgentMemoryDraft | undefined;
  readonly isLoaded: boolean;
  readonly loadError: boolean;
  readonly reload: () => void;
}

export const useAgentMemories = (): UseAgentMemoriesResult => {
  const [memories, setMemories] = useState<AgentMemory[]>([]);
  const [pendingDraft, setPendingDraft] = useState<PendingAgentMemoryDraft | undefined>();
  const [isLoaded, setIsLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const refreshControlRef = useRef(createLatestOnlyRefresh());
  const initialRetryUsedRef = useRef(false);

  const refresh = useCallback(async (): Promise<'applied' | 'failed' | 'stale'> => {
    const result = await refreshControlRef.current.run(async () => {
      const [nextMemories, nextDraft] = await Promise.all([
        loadAgentMemories(storage),
        loadPendingAgentMemoryDraft(storage),
      ]);
      return { memories: nextMemories, pendingDraft: nextDraft };
    });

    if (result.status === 'stale') {
      return 'stale';
    }

    if (result.status === 'failed') {
      return 'failed';
    }

    setMemories(result.value.memories);
    setPendingDraft(result.value.pendingDraft);
    setLoadError(false);
    setIsLoaded(true);
    return 'applied';
  }, []);

  const refreshWithFailureHandling = useCallback(
    async ({ isInitialLoad }: { isInitialLoad: boolean }): Promise<void> => {
      const outcome = await refresh();

      if (outcome === 'applied' || outcome === 'stale') {
        // Stale failures and superseded successes leave prior state untouched.
        return;
      }

      // Latest generation failed.
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

    const unwatchMemories = storage.watch(AGENT_MEMORIES_STORAGE_KEY, () => {
      void refreshWithFailureHandling({ isInitialLoad: false });
    });
    const unwatchDraft = storage.watch(PENDING_AGENT_MEMORY_DRAFT_STORAGE_KEY, () => {
      void refreshWithFailureHandling({ isInitialLoad: false });
    });

    return () => {
      unwatchMemories();
      unwatchDraft();
    };
  }, [refreshWithFailureHandling]);

  return {
    isLoaded,
    loadError,
    memories,
    pendingDraft,
    reload,
  };
};
