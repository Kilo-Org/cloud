import { Effect } from 'effect';

import { type RemoteMcpOfferedTool } from '@kilocode/harness-sdk/plugins/remote-mcp';

import { type RemoteMcpServerState } from './remote-mcp-state';
import { type StoredRemoteMcpServer } from './remote-mcp-store';
import { type ChatPlace } from './scope';

/**
 * The values the remote-MCP tests build their world from: a place, a stored
 * server, a tool and the state a server is expected to be drawn in. Shared by
 * the tests beside this file so each one names only the field it is about, and
 * so a discovery can be held open across a config change in a test.
 */

export const place: ChatPlace = { chatScope: 'user-1:personal', org: { kind: 'personal' } };

/** A stored server, so each test names only the field it is about. */
export function server(
  fields: Partial<StoredRemoteMcpServer> & Pick<StoredRemoteMcpServer, 'id'>
): StoredRemoteMcpServer {
  return {
    name: fields.id,
    url: `https://${fields.id}.example/mcp`,
    auth: { type: 'none' },
    enabled: true,
    ...fields,
  };
}

/**
 * A tool as the harness offers one: the name the model calls it by, the name
 * the server calls it by, and the view it carries when a test gives it one.
 */
export function tool(
  name: string,
  fields: { readonly serverToolName?: string; readonly uiResourceUri?: string } = {}
): RemoteMcpOfferedTool {
  return {
    definition: {
      name,
      description: 'A tool the server offers.',
      parameters: { type: 'object', properties: {} },
    },
    serverToolName: fields.serverToolName ?? name.split('_').slice(2).join('_'),
    ...(fields.uiResourceUri === undefined ? {} : { uiResourceUri: fields.uiResourceUri }),
    run: () => Effect.succeed(''),
  };
}

/** The same, carrying the MCP Apps view the server attached to it. */
export function viewTool(name: string, serverToolName: string, uri: string): RemoteMcpOfferedTool {
  return tool(name, { serverToolName, uiResourceUri: uri });
}

/** The state a server is expected to be drawn in. */
export function stateOf(
  held: StoredRemoteMcpServer,
  fields: {
    readonly status: RemoteMcpServerState['status'];
    readonly toolCount: number;
    readonly retryable: boolean;
  }
): RemoteMcpServerState {
  return {
    id: held.id,
    name: held.name,
    url: held.url,
    enabled: held.enabled,
    status: fields.status,
    toolCount: fields.toolCount,
    retryable: fields.retryable,
  };
}
