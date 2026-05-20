'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import { CLOUD_AGENT_NEXT_WS_URL } from '@/lib/constants';
import { useTRPC } from '@/lib/trpc/utils';
import {
  classifyTerminalCreateError,
  classifyTerminalSocketClose,
  getTerminalReconnectDelayMs,
  isPtyControlFrame,
  resolveCloudAgentTerminalWsUrl,
} from './terminal-utils';

export type TerminalStatus =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'exited'
  | 'error';

type CloudAgentTerminalResult = {
  terminalRef: RefObject<HTMLDivElement | null>;
  status: TerminalStatus;
  statusText: string;
  connected: boolean;
  reconnect: () => void;
};

const RESIZE_DEBOUNCE_MS = 150;

export function useCloudAgentTerminal({
  cloudAgentSessionId,
  organizationId,
  enabled,
  active,
}: {
  cloudAgentSessionId: string | null | undefined;
  organizationId?: string;
  enabled: boolean;
  active: boolean;
}): CloudAgentTerminalResult {
  const trpc = useTRPC();
  const [status, setStatus] = useState<TerminalStatus>('disconnected');
  const [statusText, setStatusText] = useState('Disconnected');
  const terminalRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const intentionalCloseRef = useRef(false);
  const ptyIdRef = useRef<string | null>(null);
  const activeRef = useRef(active);
  const reconnectNowRef = useRef<() => void>(() => {});

  activeRef.current = active;

  const personalCreate = useMutation(trpc.cloudAgentNext.createTerminal.mutationOptions());
  const orgCreate = useMutation(trpc.organizations.cloudAgentNext.createTerminal.mutationOptions());
  const personalRefreshTicket = useMutation(
    trpc.cloudAgentNext.refreshTerminalTicket.mutationOptions()
  );
  const orgRefreshTicket = useMutation(
    trpc.organizations.cloudAgentNext.refreshTerminalTicket.mutationOptions()
  );
  const personalResize = useMutation(trpc.cloudAgentNext.resizeTerminal.mutationOptions());
  const orgResize = useMutation(trpc.organizations.cloudAgentNext.resizeTerminal.mutationOptions());
  const personalClose = useMutation(trpc.cloudAgentNext.closeTerminal.mutationOptions());
  const orgClose = useMutation(trpc.organizations.cloudAgentNext.closeTerminal.mutationOptions());

  const personalCreateRef = useRef(personalCreate.mutateAsync);
  const orgCreateRef = useRef(orgCreate.mutateAsync);
  const personalRefreshTicketRef = useRef(personalRefreshTicket.mutateAsync);
  const orgRefreshTicketRef = useRef(orgRefreshTicket.mutateAsync);
  const personalResizeRef = useRef(personalResize.mutate);
  const orgResizeRef = useRef(orgResize.mutate);
  const personalCloseRef = useRef(personalClose.mutate);
  const orgCloseRef = useRef(orgClose.mutate);

  personalCreateRef.current = personalCreate.mutateAsync;
  orgCreateRef.current = orgCreate.mutateAsync;
  personalRefreshTicketRef.current = personalRefreshTicket.mutateAsync;
  orgRefreshTicketRef.current = orgRefreshTicket.mutateAsync;
  personalResizeRef.current = personalResize.mutate;
  orgResizeRef.current = orgResize.mutate;
  personalCloseRef.current = personalClose.mutate;
  orgCloseRef.current = orgClose.mutate;

  const createTerminal = useCallback(
    (input: { cloudAgentSessionId: string; cols?: number; rows?: number }) => {
      if (organizationId) {
        return orgCreateRef.current({ ...input, organizationId });
      }
      return personalCreateRef.current(input);
    },
    [organizationId]
  );

  const refreshTerminalTicket = useCallback(
    (input: { cloudAgentSessionId: string; ptyId: string }) => {
      if (organizationId) {
        return orgRefreshTicketRef.current({ ...input, organizationId });
      }
      return personalRefreshTicketRef.current(input);
    },
    [organizationId]
  );

  const resizeTerminal = useCallback(
    (input: { cloudAgentSessionId: string; ptyId: string; cols: number; rows: number }) => {
      if (organizationId) {
        orgResizeRef.current({ ...input, organizationId });
        return;
      }
      personalResizeRef.current(input);
    },
    [organizationId]
  );

  const closeTerminal = useCallback(
    (input: { cloudAgentSessionId: string; ptyId: string }) => {
      if (organizationId) {
        orgCloseRef.current({ ...input, organizationId });
        return;
      }
      personalCloseRef.current(input);
    },
    [organizationId]
  );

  const reconnect = useCallback(() => {
    reconnectNowRef.current();
  }, []);

  useEffect(() => {
    if (!active || !cloudAgentSessionId) return;

    const frame = requestAnimationFrame(() => {
      fitAddonRef.current?.fit();
      const dims = fitAddonRef.current?.proposeDimensions();
      const ptyId = ptyIdRef.current;
      if (dims && ptyId) {
        resizeTerminal({
          cloudAgentSessionId,
          ptyId,
          cols: dims.cols,
          rows: dims.rows,
        });
      }
    });

    return () => cancelAnimationFrame(frame);
  }, [active, cloudAgentSessionId, resizeTerminal]);

  useEffect(() => {
    if (!enabled || !cloudAgentSessionId) return;

    let disposed = false;
    const capturedSessionId = cloudAgentSessionId;
    intentionalCloseRef.current = false;

    function updateStatus(next: TerminalStatus, text: string) {
      if (disposed) return;
      setStatus(next);
      setStatusText(text);
    }

    updateStatus('connecting', 'Connecting terminal');

    function sendResize(cols: number, rows: number) {
      const ptyId = ptyIdRef.current;
      if (!ptyId) return;
      resizeTerminal({ cloudAgentSessionId: capturedSessionId, ptyId, cols, rows });
    }

    function scheduleResizeFit() {
      if (!activeRef.current) return;
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = setTimeout(() => {
        resizeTimerRef.current = null;
        if (disposed || !activeRef.current) return;
        fitAddonRef.current?.fit();
      }, RESIZE_DEBOUNCE_MS);
    }

    function scheduleReconnect(term: Terminal, fitAddon: FitAddon, text: string) {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);

      const attempt = reconnectAttemptsRef.current;
      const delay = getTerminalReconnectDelayMs(attempt);
      reconnectAttemptsRef.current = attempt + 1;
      updateStatus('reconnecting', text);
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        if (!disposed) void reconnectTerminal(term, fitAddon);
      }, delay);
    }

    function connectWs(term: Terminal, fitAddon: FitAddon, wsUrl: string) {
      const ws = new WebSocket(resolveCloudAgentTerminalWsUrl(wsUrl, CLOUD_AGENT_NEXT_WS_URL));
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onopen = () => {
        if (disposed) return;
        reconnectAttemptsRef.current = 0;
        updateStatus('connected', 'Connected');
        const dims = fitAddon.proposeDimensions();
        if (dims) sendResize(dims.cols, dims.rows);
      };

      ws.onmessage = event => {
        if (disposed || isPtyControlFrame(event.data)) return;
        if (event.data instanceof ArrayBuffer) {
          term.write(new Uint8Array(event.data));
          return;
        }
        term.write(event.data);
      };

      ws.onclose = event => {
        if (disposed) return;
        if (wsRef.current === ws) wsRef.current = null;
        if (intentionalCloseRef.current) {
          updateStatus('disconnected', 'Disconnected');
          return;
        }

        const decision = classifyTerminalSocketClose({
          code: event.code,
          reason: event.reason,
        });

        if (decision.kind === 'retry') {
          scheduleReconnect(term, fitAddon, decision.statusText);
          return;
        }

        const previousPtyId = ptyIdRef.current;
        ptyIdRef.current = null;
        if (previousPtyId) {
          closeTerminal({ cloudAgentSessionId: capturedSessionId, ptyId: previousPtyId });
        }

        updateStatus(decision.kind === 'exited' ? 'exited' : 'error', decision.statusText);
      };

      ws.onerror = () => {
        if (!disposed) updateStatus('reconnecting', 'Connection issue');
      };
    }

    async function reconnectTerminal(term: Terminal, fitAddon: FitAddon) {
      const ptyId = ptyIdRef.current;
      if (!ptyId) {
        await createAndConnect(term, fitAddon);
        return;
      }

      if (reconnectAttemptsRef.current === 0) {
        updateStatus('reconnecting', 'Retrying terminal');
      }
      try {
        const result = await refreshTerminalTicket({
          cloudAgentSessionId: capturedSessionId,
          ptyId,
        });
        if (!disposed) connectWs(term, fitAddon, result.wsUrl);
      } catch (error) {
        if (disposed) return;
        const decision = classifyTerminalCreateError(error);
        if (decision.kind === 'retry') {
          scheduleReconnect(term, fitAddon, decision.statusText);
          return;
        }
        updateStatus('error', decision.statusText);
      }
    }

    async function createAndConnect(term: Terminal, fitAddon: FitAddon) {
      if (reconnectAttemptsRef.current === 0) {
        updateStatus('connecting', 'Connecting terminal');
      }
      const dims = fitAddon.proposeDimensions();
      try {
        const result = await createTerminal({
          cloudAgentSessionId: capturedSessionId,
          cols: dims?.cols,
          rows: dims?.rows,
        });
        if (disposed) {
          closeTerminal({ cloudAgentSessionId: capturedSessionId, ptyId: result.ptyId });
          return;
        }

        ptyIdRef.current = result.ptyId;
        connectWs(term, fitAddon, result.wsUrl);
      } catch (error) {
        if (disposed) return;
        const decision = classifyTerminalCreateError(error);
        if (decision.kind === 'retry') {
          scheduleReconnect(term, fitAddon, decision.statusText);
          return;
        }
        updateStatus('error', decision.statusText);
      }
    }

    async function init() {
      const container = terminalRef.current;
      if (!container) return;

      const [{ Terminal }, { FitAddon }, { WebLinksAddon }, { ClipboardAddon }] = await Promise.all(
        [
          import('@xterm/xterm'),
          import('@xterm/addon-fit'),
          import('@xterm/addon-web-links'),
          import('@xterm/addon-clipboard'),
        ]
      );

      if (disposed) return;

      const fitAddon = new FitAddon();
      const term = new Terminal({
        cursorBlink: true,
        fontSize: 13,
        lineHeight: 1.25,
        fontFamily:
          '"JetBrains Mono", "Roboto Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        theme: {
          background: '#0a0a0a',
          foreground: '#e5e5e5',
          cursor: '#fafafa',
          selectionBackground: '#404040',
        },
        allowProposedApi: true,
        scrollback: 5000,
      });

      term.loadAddon(fitAddon);
      term.loadAddon(new WebLinksAddon());
      term.loadAddon(new ClipboardAddon());
      term.open(container);
      fitAddon.fit();

      xtermRef.current = term;
      fitAddonRef.current = fitAddon;
      reconnectNowRef.current = () => {
        if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
        reconnectAttemptsRef.current = 0;
        intentionalCloseRef.current = false;
        void reconnectTerminal(term, fitAddon);
      };

      term.onResize(({ cols, rows }) => sendResize(cols, rows));
      term.onData(data => {
        const ws = wsRef.current;
        if (ws?.readyState === WebSocket.OPEN) ws.send(data);
      });

      const observer = new ResizeObserver(scheduleResizeFit);
      observer.observe(container);
      resizeObserverRef.current = observer;

      await createAndConnect(term, fitAddon);
    }

    void init();

    return () => {
      disposed = true;
      intentionalCloseRef.current = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      resizeObserverRef.current?.disconnect();
      wsRef.current?.close(1000, 'Terminal closed');
      const ptyId = ptyIdRef.current;
      if (ptyId) {
        closeTerminal({ cloudAgentSessionId: capturedSessionId, ptyId });
      }
      wsRef.current = null;
      ptyIdRef.current = null;
      xtermRef.current?.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
      resizeObserverRef.current = null;
      reconnectNowRef.current = () => {};
      updateStatus('disconnected', 'Disconnected');
    };
  }, [
    cloudAgentSessionId,
    closeTerminal,
    createTerminal,
    enabled,
    refreshTerminalTicket,
    resizeTerminal,
  ]);

  return {
    terminalRef,
    status,
    statusText,
    connected: status === 'connected',
    reconnect,
  };
}
