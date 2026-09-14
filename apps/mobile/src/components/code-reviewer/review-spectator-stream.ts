import {
  type CloudAgentEvent,
  type Connection,
  createConnection,
  type StreamError,
} from '@kilocode/cloud-agent-sdk';
import { fetchCloudAgentStreamTicket } from '@/lib/cloud-agent-stream-ticket';
import { createNativeUserWebConnectionLifecycleHooks } from '@/lib/user-web-connection-lifecycle';
import { CLOUD_AGENT_WS_URL, WEB_BASE_URL } from '@/lib/config';

export type { Connection };

/** Build the raw `/stream` websocket URL. `createConnection` appends `ticket`. */
function buildSpectatorStreamUrl(cloudAgentSessionId: string): URL {
  const url = new URL('/stream', CLOUD_AGENT_WS_URL);
  url.searchParams.set('cloudAgentSessionId', cloudAgentSessionId);
  return url;
}

/**
 * Open a raw cloud-agent stream that only watches a review; it never sends a
 * prompt or command. `createConnection` owns reconnect and teardown.
 */
export async function createReviewSpectatorStream(input: {
  cloudAgentSessionId: string;
  organizationId?: string;
  onEvent: (event: CloudAgentEvent) => void;
  onConnected: () => void;
  onReconnected: () => void;
  onDisconnected: () => void;
  onError: (error: StreamError) => void;
}): Promise<Connection> {
  const organizationId =
    input.organizationId && input.organizationId.length > 0 ? input.organizationId : undefined;
  const ticketResult = await fetchCloudAgentStreamTicket(input.cloudAgentSessionId, organizationId);

  return createConnection({
    websocketUrl: buildSpectatorStreamUrl(input.cloudAgentSessionId).toString(),
    ticket: ticketResult,
    onEvent: input.onEvent,
    onConnected: input.onConnected,
    onReconnected: input.onReconnected,
    onDisconnected: input.onDisconnected,
    onError: input.onError,
    websocketHeaders: { Origin: WEB_BASE_URL },
    lifecycleHooks: createNativeUserWebConnectionLifecycleHooks(),
    onRefreshTicket: async () => {
      const ticket = await fetchCloudAgentStreamTicket(input.cloudAgentSessionId, organizationId);
      return ticket;
    },
  });
}
