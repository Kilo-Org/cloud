import { useCallback, useEffect, useRef, useState } from 'react';
import { listDirectoriesOnConnection } from '@kilocode/cloud-agent-sdk/list-directories';

import { useUserWebConnection } from '@/components/agents/user-web-connection-provider';

/** One child directory returned by `list_directories`. */
export type DirectoryEntry = { name: string; path: string };

/** The folder picker's view of the current listing. */
type ListDirectoriesState =
  | { phase: 'skeleton'; path: string }
  | { phase: 'ready'; path: string; directories: DirectoryEntry[] }
  | { phase: 'retryable'; path: string }
  | { phase: 'unsupported'; path: string };

export type UseListDirectoriesResult = {
  /** State of the most recently requested listing. */
  state: ListDirectoriesState | null;
  /**
   * List one level of `path` (`""` means the CLI launch directory). Serves a
   * previously listed path from cache synchronously; otherwise shows skeleton
   * and fetches. Each call advances the generation, so an in-flight result
   * for an abandoned path (Back, Done, dismiss, instance change) is dropped
   * when it resolves.
   */
  list: (path: string) => void;
};

/**
 * One-level directory listing client for the folder picker. The generation
 * counter is the only staleness guard: every `list` call advances it, and an
 * older in-flight result is ignored on arrival. `listDirectoriesOnConnection`
 * never throws, so no error handling lives here — the SDK classifies every
 * outcome and this hook only projects it onto three UI phases:
 *
 *   - `ready` (resolved listing, cached per path so Back has no network wait)
 *   - `retryable` (`transport`: retrying may succeed)
 *   - `unsupported` (`unsupported`/`invalid`: retrying would be pure waste)
 */
export function useListDirectories(connectionId: string | null): UseListDirectoriesResult {
  const connection = useUserWebConnection();
  const [state, setState] = useState<ListDirectoriesState | null>(null);
  const generationRef = useRef(0);
  const cacheRef = useRef(new Map<string, DirectoryEntry[]>());

  // Swipe-down without Done unmounts the screen; bump the generation so the
  // in-flight result, whenever it lands, has no live component to commit to.
  useEffect(
    () => () => {
      generationRef.current += 1;
    },
    []
  );

  const list = useCallback(
    (path: string) => {
      generationRef.current += 1;
      const generation = generationRef.current;
      const cached = cacheRef.current.get(path);
      if (cached !== undefined) {
        setState({ phase: 'ready', path, directories: cached });
        return;
      }
      setState({ phase: 'skeleton', path });
      if (connectionId === null) {
        return;
      }
      void (async () => {
        const result = await listDirectoriesOnConnection(
          connection,
          connectionId,
          path === '' ? undefined : path
        );
        if (generationRef.current !== generation) {
          // Stale result for a path the user already left.
          return;
        }
        if (result.ok) {
          cacheRef.current.set(path, result.directories);
          setState({ phase: 'ready', path, directories: result.directories });
        } else if (result.reason === 'transport') {
          setState({ phase: 'retryable', path });
        } else {
          setState({ phase: 'unsupported', path });
        }
      })();
    },
    [connection, connectionId]
  );

  return { state, list };
}
