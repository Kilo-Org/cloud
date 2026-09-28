// Context-expansion loader for the PR diff viewer. Encapsulates the
// expandedContext state and the progressive window fetch so the list
// component stays under the max-lines limit.

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';

import {
  addContextLoadState,
  type ExpandSeparatorState,
  type ListItem,
  setContextLines,
} from '@/lib/pr-review/diff/pr-diff-list-items';
import { buildContextWindow } from '@/lib/pr-review/diff/context-window';
import { buildPrFileLinesQueryOptions } from '@/lib/pr-review/provider-pr-queries';
import {
  githubPrRef,
  providerPrNumber,
  type ProviderPrScope,
  useProviderPrScope,
} from '@/lib/pr-review/provider-pr-ref';
import { useTRPC } from '@/lib/trpc';
import { readTrpcErrorField } from '@/lib/trpc-error';

type UsePrDiffContextLoaderResult = {
  expandedContext: Record<string, Record<number, ExpandSeparatorState>>;
  setExpandedContext: React.Dispatch<
    React.SetStateAction<Record<string, Record<number, ExpandSeparatorState>>>
  >;
  handleLoadContext: (
    item: Extract<ListItem, { kind: 'expand-separator' }>,
    windowSize: number
  ) => void;
};

/**
 * The scope one expand-separator reads its context under.
 *
 * A GitHub diff row can point at another repository (a cross-repo head), so
 * the row's own `owner`/`repo` win there. A GitLab merge request and a
 * Bitbucket pull request are always one project, so the screen scope stands
 * and only the git ref falls back to the head sha.
 */
export type PrDiffContextTarget = { scope: ProviderPrScope; ref: string };

export function contextScopeForItem(
  scope: ProviderPrScope,
  itemRef: { owner: string; repo: string; ref: string },
  fallback: { owner: string; repo: string; headSha: string }
): PrDiffContextTarget {
  const ref = itemRef.ref || fallback.headSha;
  if (scope.ref.platform !== 'github') {
    return { scope, ref };
  }
  return {
    scope: {
      ...scope,
      ref: githubPrRef(
        itemRef.owner || fallback.owner,
        itemRef.repo || fallback.repo,
        providerPrNumber(scope.ref)
      ),
    },
    ref,
  };
}

export function usePrDiffContextLoader(args: {
  owner: string;
  repo: string;
  headSha: string;
}): UsePrDiffContextLoaderResult {
  const { owner, repo, headSha } = args;
  const queryClient = useQueryClient();
  const trpc = useTRPC();
  // The loader has no PR number of its own; `getFileLines` is keyed by repo
  // and git ref, so the number only matters as part of the provider identity.
  const scope = useProviderPrScope({ owner, repo, number: 1 });
  const [expandedContext, setExpandedContext] = useState<
    Record<string, Record<number, ExpandSeparatorState>>
  >({});
  const expandedContextRef = useRef(expandedContext);
  expandedContextRef.current = expandedContext;

  const handleLoadContext = useCallback(
    (item: Extract<ListItem, { kind: 'expand-separator' }>, windowSize: number) => {
      const existingState = expandedContextRef.current[item.filePath]?.[item.context.gapIndex];
      const alreadyLoaded =
        existingState?.status === 'loading' ||
        existingState?.status === 'partial' ||
        existingState?.status === 'error'
          ? existingState.lines.length
          : 0;
      const { startLine, endLine } = buildContextWindow({
        startLine: item.context.startLine,
        endLine: item.context.endLine,
        alreadyLoaded,
        windowSize,
      });

      setExpandedContext(prev =>
        addContextLoadState({
          state: prev,
          filePath: item.filePath,
          gapIndex: item.context.gapIndex,
          status: 'loading',
        })
      );
      const target = contextScopeForItem(scope, item.ref, { owner, repo, headSha });
      void (async () => {
        try {
          const result = await queryClient.fetchQuery(
            buildPrFileLinesQueryOptions(trpc, target.scope, {
              ref: target.ref,
              path: item.filePath,
              startLine,
              endLine,
            })
          );
          if (result.lines.length === 0) {
            setExpandedContext(prev =>
              addContextLoadState({
                state: prev,
                filePath: item.filePath,
                gapIndex: item.context.gapIndex,
                status: 'unavailable',
              })
            );
            return;
          }
          setExpandedContext(prev =>
            setContextLines({
              state: prev,
              filePath: item.filePath,
              gapIndex: item.context.gapIndex,
              lines: result.lines,
              totalLines: result.totalLines,
            })
          );
        } catch (error: unknown) {
          const code = readTrpcErrorField(error, 'code');
          const status = code === 'NOT_FOUND' ? 'unavailable' : 'error';
          setExpandedContext(prev =>
            addContextLoadState({
              state: prev,
              filePath: item.filePath,
              gapIndex: item.context.gapIndex,
              status,
            })
          );
        }
      })();
    },
    [owner, repo, headSha, queryClient, scope, trpc]
  );

  return { expandedContext, setExpandedContext, handleLoadContext };
}
