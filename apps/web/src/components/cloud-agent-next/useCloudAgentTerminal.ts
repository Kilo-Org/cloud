'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { FitAddon, Terminal } from 'ghostty-web';
import { CLOUD_AGENT_NEXT_WS_URL } from '@kilocode/web-shared/lib/constants';
import { useTRPC } from '@/lib/trpc/utils';
import {
  SANDBOX_STATUS_DETAIL_MESSAGES,
  type SandboxLifecycleStatus,
} from '@/routers/cloud-agent-next-schemas';
import { subscribeSandboxStatus } from './sandbox-status-stream';
import {
  classifyTerminalCreateError,
  classifyTerminalSocketClose,
  getTerminalReconnectDelayMs,
  isPtyControlFrame,
  resolveCloudAgentTerminalWsUrl,
} from './terminal-utils';
import {
  createPersistentTerminalProtocol,
  isPersistentTerminalGreeting,
  type PersistentTerminalEffect,
} from './persistent-terminal-protocol';

export type TerminalStatus =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'sleeping'
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
const MAX_PENDING_RAW_INPUT = 1024;
const MAX_RESTORED_PTY_RETRIES = 1;

/**
 * How one connection streams. A Kilo v2 terminal opens with a snapshot and
 * speaks the persistent PTY protocol; any other first message is raw output.
 */
type TerminalStreamMode = 'pending' | 'raw' | 'persistent';

export function useCloudAgentTerminal({
  cloudAgentSessionId,
  organizationId,
  enabled,
  active,
  restoredPtyId,
  onPtyIdChange,
}: {
  cloudAgentSessionId: string | null | undefined;
  organizationId?: string;
  enabled: boolean;
  active: boolean;
  /** A PTY from an earlier page, which the terminal attaches to before it creates one. */
  restoredPtyId?: string;
  onPtyIdChange?: (ptyId: string | null) => void;
}): CloudAgentTerminalResult {
  const trpc = useTRPC();
  const [status, setStatus] = useState<TerminalStatus>('disconnected');
  const [statusText, setStatusText] = useState('Disconnected');
  const terminalRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const terminalInstanceRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const intentionalCloseRef = useRef(false);
  const ptyIdRef = useRef<string | null>(null);
  const activeRef = useRef(active);
  const reconnectNowRef = useRef<() => void>(() => {});
  const refitRef = useRef<() => void>(() => {});
  const applySandboxStatusRef = useRef<(status: SandboxLifecycleStatus) => void>(() => {});
  const sleepingRef = useRef(false);
  const resumeWhenActiveRef = useRef(false);

  const restoredPtyIdRef = useRef(restoredPtyId);
  const onPtyIdChangeRef = useRef(onPtyIdChange);

  activeRef.current = active;
  restoredPtyIdRef.current = restoredPtyId;
  onPtyIdChangeRef.current = onPtyIdChange;

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

    const frame = requestAnimationFrame(() => refitRef.current());

    return () => cancelAnimationFrame(frame);
  }, [active, cloudAgentSessionId]);

  useEffect(() => {
    if (!enabled || !cloudAgentSessionId) return;

    let disposed = false;
    const unsubscribe = subscribeSandboxStatus({
      baseUrl: CLOUD_AGENT_NEXT_WS_URL,
      sessionId: cloudAgentSessionId,
      getTicket: async () => {
        const response = await fetch('/api/cloud-agent-next/sessions/stream-ticket', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            cloudAgentSessionId,
            ...(organizationId ? { organizationId } : {}),
          }),
        });
        if (!response.ok) throw new Error('Sandbox status authorization failed');
        const data: unknown = await response.json();
        if (
          !data ||
          typeof data !== 'object' ||
          typeof (data as { ticket?: unknown }).ticket !== 'string' ||
          typeof (data as { expiresAt?: unknown }).expiresAt !== 'number'
        ) {
          throw new Error('Invalid sandbox status ticket');
        }
        return {
          ticket: (data as { ticket: string }).ticket,
          expiresAt: (data as { expiresAt: number }).expiresAt,
        };
      },
      onSnapshot: snapshot => {
        if (!disposed) applySandboxStatusRef.current(snapshot.status);
      },
      onDisconnected: () => undefined,
    });

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [cloudAgentSessionId, enabled, organizationId]);

  useEffect(() => {
    if (!enabled || !cloudAgentSessionId) return;

    let disposed = false;
    const capturedSessionId = cloudAgentSessionId;
    intentionalCloseRef.current = false;
    const encoder = new TextEncoder();
    let mode: TerminalStreamMode = 'pending';
    let protocol = createPersistentTerminalProtocol();
    let pendingRawInput: string[] = [];
    let writing = false;
    let restoredPty: string | null = null;
    let reachedPty: string | null = null;
    let connectionReplaced = false;

    function updateStatus(next: TerminalStatus, text: string) {
      if (disposed) return;
      setStatus(next);
      setStatusText(text);
    }

    updateStatus('connecting', 'Connecting terminal');

    function setPtyId(ptyId: string | null) {
      ptyIdRef.current = ptyId;
      onPtyIdChangeRef.current?.(ptyId);
    }

    function isUnreachedRestoredPty(): boolean {
      const ptyId = ptyIdRef.current;
      return ptyId !== null && ptyId === restoredPty && ptyId !== reachedPty;
    }

    function canRetryConnection(): boolean {
      return !isUnreachedRestoredPty() || reconnectAttemptsRef.current < MAX_RESTORED_PTY_RETRIES;
    }

    function replaceUnreachedRestoredPty(term: Terminal, fitAddon: FitAddon) {
      restoredPty = null;
      pendingRawInput = [];
      setPtyId(null);
      reconnectAttemptsRef.current = 0;
      void createAndConnect(term, fitAddon);
    }

    function retirePty() {
      const ptyId = ptyIdRef.current;
      setPtyId(null);
      if (ptyId) closeTerminal({ cloudAgentSessionId: capturedSessionId, ptyId });
    }

    function stopInput(term: Terminal) {
      pendingRawInput = [];
      term.options.disableStdin = true;
    }

    function sendResize(cols: number, rows: number) {
      // A persistent PTY takes its size from input frames instead.
      if (mode !== 'raw') return;
      const ptyId = ptyIdRef.current;
      if (!ptyId) return;
      resizeTerminal({ cloudAgentSessionId: capturedSessionId, ptyId, cols, rows });
    }

    function sendFrame(frame: Uint8Array<ArrayBuffer>) {
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) ws.send(frame);
    }

    function writeOutput(term: Terminal, data: Uint8Array) {
      // ghostty-web answers terminal queries while it writes; the PTY service already answered them.
      writing = true;
      try {
        term.write(data);
      } finally {
        writing = false;
      }
    }

    function applyEffects(term: Terminal, effects: PersistentTerminalEffect[]) {
      for (const effect of effects) {
        if (effect.type === 'resize') term.resize(effect.size.cols, effect.size.rows);
        else if (effect.type === 'write') writeOutput(term, effect.data);
        else if (effect.type === 'send') sendFrame(effect.frame);
        else if (effect.type === 'exited') {
          stopInput(term);
          updateStatus('exited', 'Terminal exited');
        } else {
          stopInput(term);
          updateStatus('error', 'Terminal service is outdated');
        }
      }
    }

    /**
     * A raw terminal fits the emulator to the pane. A persistent PTY owns the
     * emulator size, so the pane only asks for its measured size.
     */
    function fitPane(term: Terminal, fitAddon: FitAddon) {
      if (mode !== 'persistent') {
        fitAddon.fit();
        return;
      }
      const dims = fitAddon.proposeDimensions();
      if (dims) applyEffects(term, protocol.size(dims));
    }

    function scheduleResizeFit() {
      if (!activeRef.current) return;
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = setTimeout(() => {
        resizeTimerRef.current = null;
        const term = terminalInstanceRef.current;
        const fitAddon = fitAddonRef.current;
        if (disposed || !activeRef.current || !term || !fitAddon) return;
        fitPane(term, fitAddon);
      }, RESIZE_DEBOUNCE_MS);
    }

    /** Chooses the stream mode from a connection's first message. */
    function startStream(term: Terminal, fitAddon: FitAddon, first: string | ArrayBuffer) {
      const dims = fitAddon.proposeDimensions();
      const held = pendingRawInput;
      pendingRawInput = [];
      if (isPersistentTerminalGreeting(first)) {
        mode = 'persistent';
        if (dims) applyEffects(term, protocol.size(dims));
        for (const data of held) applyEffects(term, protocol.input(encoder.encode(data)));
        return;
      }
      mode = 'raw';
      if (dims) sendResize(dims.cols, dims.rows);
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) for (const data of held) ws.send(data);
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

    function enterSleeping(term: Terminal) {
      sleepingRef.current = true;
      resumeWhenActiveRef.current = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
      reconnectAttemptsRef.current = 0;
      setPtyId(null);
      stopInput(term);
      const ws = wsRef.current;
      wsRef.current = null;
      ws?.close(1000, 'Terminal sleeping');
      updateStatus('sleeping', SANDBOX_STATUS_DETAIL_MESSAGES.sandbox_stopped);
    }

    function applySandboxStatus(
      term: Terminal,
      fitAddon: FitAddon,
      status: SandboxLifecycleStatus
    ) {
      if (connectionReplaced) return;
      if (status === 'sleeping') {
        enterSleeping(term);
        return;
      }

      if (status !== 'active' || !resumeWhenActiveRef.current) return;

      resumeWhenActiveRef.current = false;
      sleepingRef.current = false;
      term.options.disableStdin = false;
      reconnectAttemptsRef.current = 0;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
      void reconnectTerminal(term, fitAddon);
    }

    function connectWs(term: Terminal, fitAddon: FitAddon, wsUrl: string) {
      const ws = new WebSocket(resolveCloudAgentTerminalWsUrl(wsUrl, CLOUD_AGENT_NEXT_WS_URL));
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;
      mode = 'pending';
      protocol = createPersistentTerminalProtocol();

      ws.onopen = () => {
        if (disposed || wsRef.current !== ws) return;
        connectionReplaced = false;
        sleepingRef.current = false;
        resumeWhenActiveRef.current = false;
        term.options.disableStdin = false;
        updateStatus('connected', 'Connected');
      };

      ws.onmessage = event => {
        if (disposed || wsRef.current !== ws) return;
        if (mode === 'pending') {
          reconnectAttemptsRef.current = 0;
          reachedPty = ptyIdRef.current;
          startStream(term, fitAddon, event.data);
        }
        if (mode === 'persistent') {
          if (typeof event.data === 'string') applyEffects(term, protocol.message(event.data));
          else if (protocol.acceptsOutput()) writeOutput(term, new Uint8Array(event.data));
          return;
        }
        if (isPtyControlFrame(event.data)) return;
        if (event.data instanceof ArrayBuffer) {
          term.write(new Uint8Array(event.data));
          return;
        }
        term.write(event.data);
      };

      ws.onclose = event => {
        if (disposed || wsRef.current !== ws) return;
        wsRef.current = null;
        if (sleepingRef.current) {
          updateStatus('sleeping', SANDBOX_STATUS_DETAIL_MESSAGES.sandbox_stopped);
          return;
        }
        if (intentionalCloseRef.current) {
          updateStatus('disconnected', 'Disconnected');
          return;
        }
        const decision = classifyTerminalSocketClose({
          code: event.code,
          reason: event.reason,
        });

        if (decision.kind === 'replaced') {
          connectionReplaced = true;
          stopInput(term);
          updateStatus('error', decision.statusText);
          return;
        }

        if (protocol.hasExited()) {
          retirePty();
          return;
        }

        if (isUnreachedRestoredPty() && decision.kind === 'exited') {
          replaceUnreachedRestoredPty(term, fitAddon);
          return;
        }

        if (decision.kind === 'retry') {
          if (canRetryConnection()) {
            scheduleReconnect(term, fitAddon, decision.statusText);
          } else {
            stopInput(term);
            updateStatus('error', 'Terminal connection failed');
          }
          return;
        }

        if (!connectionReplaced && !isUnreachedRestoredPty()) retirePty();
        stopInput(term);
        updateStatus(decision.kind === 'exited' ? 'exited' : 'error', decision.statusText);
      };

      ws.onerror = () => {
        if (!disposed && wsRef.current === ws && !protocol.hasExited()) {
          updateStatus('reconnecting', 'Connection issue');
        }
      };
    }

    async function reconnectTerminal(term: Terminal, fitAddon: FitAddon) {
      const ptyId = ptyIdRef.current;
      if (!ptyId) {
        await createAndConnect(term, fitAddon);
        return;
      }

      if (reconnectAttemptsRef.current === 0 && !sleepingRef.current) {
        if (ptyId === restoredPty && reachedPty !== ptyId) {
          updateStatus('connecting', 'Connecting terminal');
        } else {
          updateStatus('reconnecting', 'Retrying terminal');
        }
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
        if (decision.kind === 'sleeping') {
          enterSleeping(term);
          return;
        }
        if (decision.kind === 'retry' && canRetryConnection()) {
          scheduleReconnect(term, fitAddon, decision.statusText);
          return;
        }
        stopInput(term);
        updateStatus(
          'error',
          decision.kind === 'retry' ? 'Terminal connection failed' : decision.statusText
        );
      }
    }

    async function createAndConnect(term: Terminal, fitAddon: FitAddon) {
      if (reconnectAttemptsRef.current === 0 && !sleepingRef.current) {
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

        setPtyId(result.ptyId);
        connectWs(term, fitAddon, result.wsUrl);
      } catch (error) {
        if (disposed) return;
        const decision = classifyTerminalCreateError(error);
        if (decision.kind === 'sleeping') {
          enterSleeping(term);
          return;
        }
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

      const { init: initGhostty, Terminal, FitAddon } = await import('ghostty-web');
      try {
        await initGhostty();
      } catch {
        updateStatus('error', 'Terminal failed to load');
        return;
      }

      if (disposed) return;

      const fitAddon = new FitAddon();
      const term = new Terminal({
        cursorBlink: true,
        fontSize: 13,
        fontFamily:
          '"JetBrains Mono", "Roboto Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        theme: {
          background: '#0a0a0a',
          foreground: '#e5e5e5',
          cursor: '#fafafa',
          selectionBackground: '#404040',
        },
        scrollback: 5000,
      });

      term.loadAddon(fitAddon);
      term.open(container);
      fitAddon.fit();

      terminalInstanceRef.current = term;
      fitAddonRef.current = fitAddon;
      applySandboxStatusRef.current = status => {
        if (!disposed) applySandboxStatus(term, fitAddon, status);
      };
      refitRef.current = () => {
        if (disposed) return;
        fitPane(term, fitAddon);
        const dims = fitAddon.proposeDimensions();
        if (dims) sendResize(dims.cols, dims.rows);
      };
      reconnectNowRef.current = () => {
        if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
        reconnectAttemptsRef.current = 0;
        intentionalCloseRef.current = false;
        if (protocol.hasExited() && ptyIdRef.current) retirePty();
        const ws = wsRef.current;
        wsRef.current = null;
        ws?.close(1000, 'Terminal reconnecting');
        mode = 'pending';
        if (!sleepingRef.current) term.options.disableStdin = false;
        void reconnectTerminal(term, fitAddon);
      };

      term.onResize(({ cols, rows }) => sendResize(cols, rows));
      term.onData(data => {
        if (sleepingRef.current) return;
        if (mode === 'persistent') {
          if (!writing) applyEffects(term, protocol.input(encoder.encode(data)));
          return;
        }
        if (mode === 'pending') {
          if (pendingRawInput.length < MAX_PENDING_RAW_INPUT) pendingRawInput.push(data);
          return;
        }
        const ws = wsRef.current;
        if (ws?.readyState === WebSocket.OPEN) ws.send(data);
      });

      const observer = new ResizeObserver(scheduleResizeFit);
      observer.observe(container);
      resizeObserverRef.current = observer;

      restoredPty = restoredPtyIdRef.current ?? null;
      if (restoredPty) {
        ptyIdRef.current = restoredPty;
        await reconnectTerminal(term, fitAddon);
        return;
      }
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
      if (ptyId && !connectionReplaced && !isUnreachedRestoredPty()) {
        closeTerminal({ cloudAgentSessionId: capturedSessionId, ptyId });
      }
      wsRef.current = null;
      ptyIdRef.current = null;
      terminalInstanceRef.current?.dispose();
      terminalInstanceRef.current = null;
      fitAddonRef.current = null;
      resizeObserverRef.current = null;
      reconnectNowRef.current = () => {};
      refitRef.current = () => {};
      applySandboxStatusRef.current = () => {};
      sleepingRef.current = false;
      resumeWhenActiveRef.current = false;
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
