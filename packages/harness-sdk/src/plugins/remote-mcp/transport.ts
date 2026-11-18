import type { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/**
 * The transport the client library is handed. Not the library's `Transport`
 * itself: the class reads `sessionId` as `string | undefined` and the interface
 * declares it `sessionId?: string`, which `exactOptionalPropertyTypes` refuses
 * to join. Nothing here reads the member — the library owns it — so it is left
 * off the seam, not asserted.
 */
type RemoteMcpTransport = Omit<StreamableHTTPClientTransport, 'sessionId'>;

export type { RemoteMcpTransport };
