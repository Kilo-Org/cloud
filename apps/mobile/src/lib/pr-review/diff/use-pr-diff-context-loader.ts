// Context-expansion loader for the PR diff viewer. Encapsulates the
// expandedContext state and the progressive window fetch so the list
// component stays under the max-lines limit.

import { useCallback, useRef, useState } from 'react';

import {
  addContextLoadState,
  type ExpandSeparatorState,
  type ListItem,
  readTrpcErrorCode,
  setContextLines,
} from '@/lib/pr-review/diff/pr-diff-list-items';
import { trpcClient } from '@/lib/trpc';

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

export function usePrDiffContextLoader(args: {
  owner: string;
  repo: string;
  headSha: string;
}): UsePrDiffContextLoaderResult {
  const { owner, repo, headSha } = args;
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
      const startLine = item.context.startLine + alreadyLoaded;
      const endLine = Math.min(item.context.endLine, startLine + windowSize - 1);

      setExpandedContext(prev =>
        addContextLoadState({
          state: prev,
          filePath: item.filePath,
          gapIndex: item.context.gapIndex,
          status: 'loading',
        })
      );
      void (async () => {
        try {
          const result = await trpcClient.githubPrReview.getFileLines.query({
            owner: item.ref.owner || owner,
            repo: item.ref.repo || repo,
            ref: item.ref.ref || headSha,
            path: item.filePath,
            startLine,
            endLine,
          });
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
          const code = readTrpcErrorCode(error);
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
    [owner, repo, headSha]
  );

  return { expandedContext, setExpandedContext, handleLoadContext };
}
