'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useGastownTRPC, gastownWsUrl } from '@/lib/gastown/trpc';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';

/**
 * xterm.js doesn't support the Kitty keyboard protocol — all Enter
 * variants are encoded as bare `\r`. The remote TUI enables Kitty
 * protocol (`\x1b[>5u`) but xterm.js ignores it.
 *
 * This handler intercepts modified Enter keys and sends the correct
 * Kitty CSI u escape sequences directly over the WebSocket:
 * - Shift+Enter → `\x1b[13;2u`
 * - Alt+Enter   → `\x1b[13;3u`
 * - Ctrl+Enter  → `\x1b[13;5u`
 *
 * Both keydown and keyup events are suppressed for modified Enter to
 * prevent xterm from also sending its default `\r`.
 */
export function attachKittyEnterHandler(term: Terminal, wsRef?: React.RefObject<WebSocket | null>) {
  function send(seq: string) {
    if (wsRef?.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(seq);
    } else {
      term.input(seq);
    }
  }

  term.attachCustomKeyEventHandler(ev => {
    // Block both keydown and keyup for modified Enter to prevent xterm
    // from sending its default \r on either event phase.
    const isModifiedEnter =
      ev.key === 'Enter' && (ev.shiftKey || ev.altKey || ev.ctrlKey) && !ev.metaKey;

    if (!isModifiedEnter) return true;

    // Only send the sequence on keydown, but suppress keyup too
    if (ev.type !== 'keydown') return false;

    if (ev.shiftKey && !ev.ctrlKey && !ev.altKey) {
      send('\x1b[13;2u');
    } else if (ev.altKey && !ev.ctrlKey && !ev.shiftKey) {
      send('\x1b[13;3u');
    } else if (ev.ctrlKey && !ev.shiftKey && !ev.altKey) {
      send('\x1b[13;5u');
    }
    return false;
  });
}

type XtermPtyOptions = {
  townId: string;
  agentId: string | null;
  /** Number of retry attempts for PTY creation (default: 1, no retries). */
  retries?: number;
  /** Delay in ms between retries (default: 3000). */
  retryDelay?: number;
  /** Called when status changes (e.g. "Connecting...", "Connected"). */
  onStatusChange?: (status: string) => void;
};

type ConnectionStatus = 'connected' | 'reconnecting' | 'disconnected';

type XtermPtyResult = {
  terminalRef: React.RefObject<HTMLDivElement | null>;
  connected: boolean;
  connectionStatus: ConnectionStatus;
  status: string;
  fitAddonRef: React.RefObject<FitAddon | null>;
};

/** Debounce interval for ResizeObserver events (ms). */
const RESIZE_DEBOUNCE_MS = 150;

/** Max reconnection attempts before giving up. */
const MAX_RECONNECT_ATTEMPTS = 8;

/** Base delay for exponential backoff (ms). */
const RECONNECT_BASE_DELAY_MS = 1_000;

/** Max backoff cap (ms). */
const RECONNECT_MAX_DELAY_MS = 8_000;

/**
 * Shared hook that sets up an xterm.js terminal connected to a PTY session
 * via WebSocket. Used by MayorTerminalPane, AgentTerminalPane, and any
 * other component that needs a terminal.
 *
 * Handles:
 * - PTY session creation with retries
 * - WebSocket connection with automatic reconnection (exponential backoff)
 * - 0x00 control frame filtering (SDK cursor metadata)
 * - Debounced resize events to prevent storms during CSS transitions
 * - Connection status indicator (connected/reconnecting/disconnected)
 */
export function useXtermPty({
  townId,
  agentId,
  retries = 1,
  retryDelay = 3_000,
  onStatusChange,
}: XtermPtyOptions): XtermPtyResult {
  const trpc = useGastownTRPC();
  const [connected, setConnected] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
  const [status, setStatus] = useState('Initializing...');

  const terminalRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const ptyRef = useRef<{ id: string } | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const intentionalCloseRef = useRef(false);
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const updateStatus = useCallback(
    (s: string) => {
      setStatus(s);
      onStatusChange?.(s);
    },
    [onStatusChange]
  );

  const createPty = useMutation(
    trpc.gastown.createPtySession.mutationOptions({
      onError: err => updateStatus(`Error: ${err.message}`),
    })
  );

  const resizePty = useMutation(trpc.gastown.resizePtySession.mutationOptions({}));
  const resizeMutateRef = useRef(resizePty.mutate);
  resizeMutateRef.current = resizePty.mutate;

  const connectedAgentRef = useRef<string | null>(null);

  useEffect(() => {
    if (!agentId || agentId === connectedAgentRef.current) return;
    const capturedAgentId = agentId;
    connectedAgentRef.current = capturedAgentId;

    let disposed = false;

    /** Connect a WebSocket to the PTY session at `wsUrl`. */
    function connectWs(
      term: Terminal,
      fitAddon: FitAddon,
      wsUrl: string,
      doResize: (cols: number, rows: number) => void
    ) {
      if (disposed) return;

      const ws = new WebSocket(gastownWsUrl(wsUrl));
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onopen = () => {
        if (disposed) return;
        reconnectAttemptsRef.current = 0;
        setConnected(true);
        setConnectionStatus('connected');
        updateStatus('Connected');
        const dims = fitAddon.proposeDimensions();
        if (dims) doResize(dims.cols, dims.rows);
      };

      ws.onmessage = (e: MessageEvent) => {
        if (e.data instanceof ArrayBuffer) {
          const bytes = new Uint8Array(e.data);
          // Filter 0x00 control frames — SDK cursor metadata.
          // The SDK sends [0x00, ...JSON.stringify({cursor: N})].
          // The NUL byte is invisible, but the JSON text renders
          // as visible garbage in the terminal.
          if (bytes.length > 0 && bytes[0] === 0x00) return;
          term.write(bytes);
        } else if (typeof e.data === 'string') {
          // Filter SDK control messages that arrive as strings.
          // The SDK sends cursor metadata as NUL-prefixed JSON or
          // plain JSON objects like {"cursor":N}. These are never
          // valid PTY output — real terminal data is raw bytes or
          // escape sequences, not well-formed JSON objects.
          const data = e.data;
          if (data.length > 0 && data.charCodeAt(0) === 0) return;
          if (data.startsWith('{')) {
            try {
              JSON.parse(data);
              // Valid JSON on the PTY WebSocket = SDK control message.
              // Actual PTY output that starts with '{' would be part
              // of a larger escape sequence and wouldn't parse as JSON.
              return;
            } catch {
              // Not valid JSON — genuine PTY data, write it
            }
          }
          term.write(data);
        }
      };

      ws.onclose = () => {
        if (disposed) return;
        setConnected(false);

        // Don't reconnect if the close was intentional (cleanup)
        if (intentionalCloseRef.current) {
          setConnectionStatus('disconnected');
          updateStatus('Disconnected');
          return;
        }

        // Exponential backoff reconnection
        const attempt = reconnectAttemptsRef.current;
        if (attempt >= MAX_RECONNECT_ATTEMPTS) {
          setConnectionStatus('disconnected');
          updateStatus('Connection lost');
          return;
        }

        setConnectionStatus('reconnecting');
        const delay = Math.min(
          RECONNECT_BASE_DELAY_MS * Math.pow(2, attempt),
          RECONNECT_MAX_DELAY_MS
        );
        updateStatus(`Reconnecting (${attempt + 1}/${MAX_RECONNECT_ATTEMPTS})...`);
        reconnectAttemptsRef.current = attempt + 1;

        reconnectTimerRef.current = setTimeout(() => {
          if (disposed) return;
          // Re-create PTY session — the old one may be gone after
          // container restart or sleep.
          void recreatePtyAndConnect(term, fitAddon, doResize);
        }, delay);
      };

      ws.onerror = () => {
        if (disposed) return;
        // onclose will fire after onerror — reconnection is handled there
      };

      term.onData(data => {
        if (ws.readyState === WebSocket.OPEN) ws.send(data);
      });
    }

    /** Re-create the PTY session and reconnect the WebSocket. */
    async function recreatePtyAndConnect(
      term: Terminal,
      fitAddon: FitAddon,
      doResize: (cols: number, rows: number) => void
    ) {
      if (disposed) return;
      try {
        const result = await new Promise<{ pty: { id: string }; wsUrl: string }>(
          (resolve, reject) => {
            createPty.mutate(
              { townId, agentId: capturedAgentId },
              { onSuccess: resolve, onError: reject }
            );
          }
        );
        if (disposed) return;
        ptyRef.current = result.pty;
        connectWs(term, fitAddon, result.wsUrl, doResize);
      } catch {
        if (disposed) return;
        // PTY creation failed — schedule another reconnect attempt
        const attempt = reconnectAttemptsRef.current;
        if (attempt >= MAX_RECONNECT_ATTEMPTS) {
          setConnectionStatus('disconnected');
          updateStatus('Connection lost');
          return;
        }
        const delay = Math.min(
          RECONNECT_BASE_DELAY_MS * Math.pow(2, attempt),
          RECONNECT_MAX_DELAY_MS
        );
        updateStatus(`Reconnecting (${attempt + 1}/${MAX_RECONNECT_ATTEMPTS})...`);
        reconnectAttemptsRef.current = attempt + 1;
        reconnectTimerRef.current = setTimeout(() => {
          if (disposed) return;
          void recreatePtyAndConnect(term, fitAddon, doResize);
        }, delay);
      }
    }

    async function init() {
      const container = terminalRef.current;
      if (!container) return;

      // Lazy-load xterm.js to avoid SSR issues and minimize bundle impact
      const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
        import('@xterm/addon-web-links'),
      ]);

      if (disposed) return;

      // Clean up any previous terminal
      xtermRef.current?.dispose();

      const fitAddon = new FitAddon();
      const webLinksAddon = new WebLinksAddon();

      const term = new Terminal({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
        theme: {
          background: '#0a0a0a',
          foreground: '#e0e0e0',
          cursor: '#e0e0e0',
          selectionBackground: '#3a3a5a',
        },
        allowProposedApi: true,
        // Disable xterm's scrollback so kilo's TUI handles all scrolling.
        scrollback: 0,
      });

      term.loadAddon(fitAddon);
      term.loadAddon(webLinksAddon);
      term.open(container);
      attachKittyEnterHandler(term, wsRef);
      fitAddon.fit();

      xtermRef.current = term;
      fitAddonRef.current = fitAddon;

      updateStatus('Creating PTY session...');

      function doResize(cols: number, rows: number) {
        if (!ptyRef.current) return;
        resizeMutateRef.current({
          townId,
          agentId: capturedAgentId,
          ptyId: ptyRef.current.id,
          cols,
          rows,
        });
      }

      // Retry PTY creation — the agent may still be starting up
      let result: { pty: { id: string }; wsUrl: string } | null = null;
      for (let attempt = 0; attempt < retries && !disposed; attempt++) {
        try {
          result = await new Promise<{ pty: { id: string }; wsUrl: string }>((resolve, reject) => {
            createPty.mutate(
              { townId, agentId: capturedAgentId },
              { onSuccess: resolve, onError: reject }
            );
          });
          break;
        } catch {
          if (disposed) return;
          if (attempt < retries - 1) {
            updateStatus(`Waiting for agent... (${attempt + 1})`);
            await new Promise(r => setTimeout(r, retryDelay));
          }
        }
      }

      if (disposed || !result) {
        if (!disposed && !result) {
          updateStatus('Failed to connect');
        }
        return;
      }

      ptyRef.current = result.pty;
      updateStatus('Connecting...');
      intentionalCloseRef.current = false;
      reconnectAttemptsRef.current = 0;

      connectWs(term, fitAddon, result.wsUrl, doResize);

      term.onResize(({ cols, rows }) => doResize(cols, rows));

      // Debounced ResizeObserver — prevents resize storms during CSS
      // transitions (sidebar expand/collapse, terminal bar resize).
      const observer = new ResizeObserver(() => {
        if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
        resizeTimerRef.current = setTimeout(() => {
          if (disposed) return;
          fitAddon.fit();
        }, RESIZE_DEBOUNCE_MS);
      });
      observer.observe(container);
      resizeObserverRef.current = observer;
    }

    void init();

    return () => {
      disposed = true;
      intentionalCloseRef.current = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = null;
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
      wsRef.current?.close(1000, 'Terminal unmount');
      wsRef.current = null;
      xtermRef.current?.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
      ptyRef.current = null;
      connectedAgentRef.current = null;
    };
  }, [agentId, townId]);

  return { terminalRef, connected, connectionStatus, status, fitAddonRef };
}
