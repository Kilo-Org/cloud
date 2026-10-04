import {
  baseGetSandboxStatusNextOutputSchema,
  type SandboxStatusSnapshot,
} from '@/routers/cloud-agent-next-schemas';
import { createWebSocketManager } from '@/lib/cloud-agent/websocket-manager';

export function subscribeSandboxStatus({
  baseUrl,
  sessionId,
  getTicket,
  onSnapshot,
  onDisconnected,
}: {
  baseUrl: string;
  sessionId: string;
  getTicket: () => Promise<{ ticket: string; expiresAt: number }>;
  onSnapshot: (snapshot: SandboxStatusSnapshot) => void;
  onDisconnected: () => void;
}) {
  let disposed = false;
  let manager: ReturnType<typeof createWebSocketManager> | undefined;
  void getTicket()
    .then(ticket => {
      if (disposed) return;
      const url = new URL('/stream', baseUrl);
      url.searchParams.set('cloudAgentSessionId', sessionId);
      url.searchParams.set('sandboxStatus', 'true');
      manager = createWebSocketManager({
        url: url.toString(),
        ticket: ticket.ticket,
        ticketExpiresAt: ticket.expiresAt,
        onRefreshTicket: getTicket,
        onStateChange: state => {
          if (!disposed && state.status !== 'connected') onDisconnected();
        },
        onError: () => {
          if (!disposed) onDisconnected();
        },
        onEvent: event => {
          if (
            disposed ||
            event.sessionId !== sessionId ||
            event.streamEventType !== 'cloud.sandbox.status'
          )
            return;
          const snapshot = baseGetSandboxStatusNextOutputSchema.safeParse(event.data);
          if (!snapshot.success) {
            onDisconnected();
            return;
          }
          onSnapshot(snapshot.data);
        },
      });
      manager.connect();
    })
    .catch(() => {
      if (!disposed) onDisconnected();
    });
  return () => {
    disposed = true;
    manager?.disconnect();
  };
}
