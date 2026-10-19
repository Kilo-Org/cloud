import { ReadResourceResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { Effect } from 'effect';
import { failed } from './failure.js';
import type { Connection } from './connection.js';
import { RemoteMcpError, type RemoteMcpServer } from './server.js';

/**
 * One resource a server holds, as `resources/read` answered it.
 *
 * A `ui://` uri names exactly one document, so the first content of the answer
 * is the resource and the rest are dropped. `text` and `blob` are the two
 * shapes the protocol allows; a host that asked for an MCP Apps view reads
 * `text` and renders it, and `blob` is there so a caller who asked for a
 * binary resource is not left with nothing.
 */
interface RemoteMcpResource {
  readonly uri: string;
  readonly mimeType: string | undefined;
  readonly text: string | undefined;
  readonly blob: string | undefined;
}

/**
 * One resource, read whole, off a connection the caller opened. The protocol
 * answers the contents of the one uri the request named, so the first content
 * is the resource; the type documents why the rest are dropped. A server that
 * answers none, or something the protocol does not allow, fails the read the
 * same way a refused call fails.
 */
const resourceOf = (
  connection: Connection,
  server: RemoteMcpServer,
  uri: string
): Effect.Effect<RemoteMcpResource, RemoteMcpError> =>
  Effect.tryPromise({
    try: async () => {
      const reply = await connection.client.readResource({ uri }, {});
      const result = ReadResourceResultSchema.parse(reply);
      const [content] = result.contents;
      if (content === undefined) {
        throw new RemoteMcpError({
          serverId: server.id,
          kind: 'protocol',
          cause: `the server answered no content for ${uri}`,
        });
      }
      const { uri: answered, mimeType } = content;
      const resource: RemoteMcpResource = {
        uri: answered,
        mimeType,
        text: 'text' in content ? content.text : undefined,
        blob: 'blob' in content ? content.blob : undefined,
      };
      return resource;
    },
    catch: cause => (cause instanceof RemoteMcpError ? cause : failed(server, cause)),
  });

export type { RemoteMcpResource };
export { resourceOf };
