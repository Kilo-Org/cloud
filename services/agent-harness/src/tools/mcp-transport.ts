import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

export type McpConnection = {
  serverId: string;
  configurationVersion: string;
  url: string;
  authorization: string;
};
type McpTransportFailure =
  | 'unsafe_destination'
  | 'reauthorization_required'
  | 'unavailable_server'
  | 'limit_exceeded';

/** Create one factory per operation. The caller supplies its deadline/cancellation signal. */
export function createMcpTransportFactory(
  signal: AbortSignal,
  httpResponseBytes: number,
  onFailure: (reason: McpTransportFailure) => never,
  fetchImpl: typeof fetch = fetch
) {
  let receivedBytes = 0;
  let failure: McpTransportFailure | undefined;
  const connections = new Set<StreamableHTTPClientTransport>();
  const stop = (reason: McpTransportFailure): never => {
    failure ??= reason;
    for (const sdk of connections) void sdk.close().catch(() => undefined);
    return onFailure(failure);
  };
  const fail = () => {
    if (failure) return;
    try {
      stop('unavailable_server');
    } catch {
      // onFailure throws; closing the SDK settles pending Client requests.
    }
  };
  signal.addEventListener('abort', fail, { once: true });
  return (connection: McpConnection): Transport => {
    if (failure) stop(failure);
    let url: URL;
    try {
      url = new URL(connection.url);
    } catch {
      return stop('unsafe_destination');
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
      stop('unsafe_destination');
    // Authorization supplies this scoped gateway route; the gateway retains upstream DNS checks.
    const destination = url.href;
    const sdk = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: connection.authorization } },
      reconnectionOptions: {
        maxRetries: 0,
        initialReconnectionDelay: 0,
        maxReconnectionDelay: 0,
        reconnectionDelayGrowFactor: 1,
      },
      fetch: async (target, init) => {
        if (failure) stop(failure);
        if (String(target) !== destination) stop('unsafe_destination');
        const requestSignal = AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]);
        requestSignal.throwIfAborted();
        const response = await fetchImpl(destination, {
          ...init,
          redirect: 'manual',
          signal: requestSignal,
        });
        if (
          (response.status >= 300 && response.status < 400) ||
          response.redirected ||
          (response.url && response.url !== destination) ||
          response.status === 400
        ) {
          void response.body?.cancel().catch(() => undefined);
          stop('unsafe_destination');
        }
        if (!response.ok && !(init?.method === 'GET' && response.status === 405)) {
          void response.body?.cancel().catch(() => undefined);
          stop(
            response.status === 401 || response.status === 403
              ? 'reauthorization_required'
              : 'unavailable_server'
          );
        }
        const reader = response.body?.getReader();
        return new Response(
          reader
            ? new ReadableStream<Uint8Array>({
                start(controller) {
                  const cancel = () => {
                    controller.error(new Error(failure ?? 'unavailable_server'));
                    void reader.cancel().catch(() => undefined);
                  };
                  requestSignal.addEventListener('abort', cancel, { once: true });
                  void reader.closed
                    .finally(() => requestSignal.removeEventListener('abort', cancel))
                    .catch(() => undefined);
                  if (requestSignal.aborted) cancel();
                },
                async pull(controller) {
                  const { done, value } = await reader.read();
                  if (done) {
                    controller.close();
                    return;
                  }
                  receivedBytes += value.byteLength;
                  if (receivedBytes > httpResponseBytes) stop('limit_exceeded');
                  controller.enqueue(value);
                },
                cancel: () => reader.cancel().catch(() => undefined),
              })
            : null,
          { status: response.status, headers: response.headers }
        );
      },
    });
    // Keep SDK parsing and session handling, but never expose its provider-bearing diagnostics.
    const transport: Transport = {
      start: () => sdk.start(),
      close: () => sdk.close(),
      async send(message, options) {
        if (failure) stop(failure);
        try {
          await sdk.send(message, options);
        } catch {
          stop(failure ?? 'unavailable_server');
        }
      },
      get sessionId() {
        return sdk.sessionId;
      },
      setProtocolVersion: version => sdk.setProtocolVersion(version),
    };
    sdk.onmessage = message => {
      if (!failure) transport.onmessage?.(message);
    };
    sdk.onclose = () => {
      if (!connections.delete(sdk)) return;
      transport.onclose?.();
      if (failure) transport.onerror?.(new Error(failure));
    };
    sdk.onerror = () => {
      if (connections.has(sdk)) fail();
    };
    connections.add(sdk);
    return transport;
  };
}
