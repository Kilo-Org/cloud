import { createFeedSource, type FeedSource } from '@kilocode/react-native-ssh';
import { useCallback, useEffect, useRef, useState } from 'react';

import { CLOUD_AGENT_WS_URL } from '@/lib/config';

import { TerminalConnection, type TerminalState } from './terminal-connection';
import { terminalOperations } from './terminal-operations';

type UseSandboxTerminalOptions = Readonly<{
  cloudAgentSessionId: string;
  organizationId?: string;
}>;

export type SandboxTerminal = Readonly<{
  /** The native byte source the terminal view draws from; null until it exists. */
  sourceId: string | null;
  state: TerminalState;
  retry: () => void;
}>;

/**
 * One Cloud Agent terminal: a native feed source in the app's terminal view,
 * fed by a JavaScript WebSocket.
 *
 * The feed source is created in an effect, not during render, so a discarded
 * render cannot leave a native source behind. Its input and resize listeners
 * are the terminal's only input path: the native view sends keystrokes and
 * geometry to the source, and the source's listeners carry them to the socket.
 */
export function useSandboxTerminal({
  cloudAgentSessionId,
  organizationId,
}: UseSandboxTerminalOptions): SandboxTerminal {
  const [feed, setFeed] = useState<FeedSource | null>(null);
  const [state, setState] = useState<TerminalState>({ kind: 'connecting' });
  const connectionRef = useRef<TerminalConnection | null>(null);

  useEffect(() => {
    const created = createFeedSource();
    setFeed(created);
    return () => {
      created.close(null, null);
    };
  }, []);

  useEffect(() => {
    if (feed === null) {
      return () => undefined;
    }

    const connection = new TerminalConnection({
      baseUrl: CLOUD_AGENT_WS_URL,
      operations: terminalOperations({ cloudAgentSessionId, organizationId }),
      onState: next => {
        setState(next);
      },
      onData: bytes => {
        feed.feed(bytes);
      },
      onClosed: notice => {
        feed.close(notice.exitStatus, notice.error);
      },
    });
    connectionRef.current = connection;

    const stopInput = feed.onInput(bytes => {
      connection.send(bytes);
    });
    const stopResize = feed.onResize(size => {
      connection.setSize(size.cols, size.rows);
    });
    connection.start();

    return () => {
      stopInput();
      stopResize();
      connection.stop();
      connectionRef.current = null;
    };
  }, [cloudAgentSessionId, feed, organizationId]);

  const retry = useCallback(() => {
    connectionRef.current?.retry();
  }, []);

  return { sourceId: feed?.sourceId ?? null, state, retry };
}
