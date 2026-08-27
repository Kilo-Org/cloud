import { useEffect, useRef } from 'react';

/**
 * Refetch the session-messages query once when the review turns terminal. A
 * running non-v2 review keeps history enabled for its whole run, so the
 * terminal flip alone does not re-enable the query, and nothing refetches on
 * its own. The completed transcript may have gained rows the in-flight
 * snapshot does not show, so the flip triggers one refetch.
 */
export function useRefetchSessionMessagesOnTerminal(
  isTerminal: boolean,
  shouldLoadHistory: boolean,
  refetch: () => Promise<void>
): void {
  const wasTerminalRef = useRef(isTerminal);
  useEffect(() => {
    const becameTerminal = isTerminal && !wasTerminalRef.current;
    wasTerminalRef.current = isTerminal;
    if (becameTerminal && shouldLoadHistory) {
      void refetch();
    }
  }, [isTerminal, shouldLoadHistory, refetch]);
}
