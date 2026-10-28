import { type Tool } from '@kilocode/harness-sdk';
import { type RemoteMcpOfferedTool } from '@kilocode/harness-sdk/plugins/remote-mcp';

import { type StoredRemoteMcpServer } from './remote-mcp-store';

/**
 * The join between the stored servers and what their discovery answered, as
 * pure functions: `remote-mcp.ts` holds the discovery, and these say what each
 * server looks like and which tools a chat may name.
 */

/** Why a server's tools are, or are not, on hand. */
type RemoteMcpStatus = 'idle' | 'connecting' | 'ready' | 'failed' | 'signIn';

/** One server's discovery result, keyed by the server's id. */
export type RemoteMcpDiscovery = {
  readonly tools: readonly Tool[];
  /** The MCP Apps view a tool carries, by the name the model calls the tool by. */
  readonly views: ReadonlyMap<string, RemoteMcpToolView>;
  /** The tools as the server names them, which is what a view calls them by. */
  readonly serverTools: readonly string[];
  /** True when the discovery did not reach the server, so none of its tools are offered. */
  readonly failed?: boolean;
  readonly signIn?: boolean;
};

/**
 * The view one discovered tool carries.
 *
 * The model calls the tool by `mcp_<server>_<tool>`; the view calls it by the
 * server's own name, and reads it from the uri the server attached. Both are
 * kept beside the discovery because the transcript draws the call by the name
 * the model used.
 */
export type RemoteMcpToolView = {
  readonly serverId: string;
  readonly serverToolName: string;
  readonly resourceUri: string;
};

/** What one server looks like to whoever draws it. */
export type RemoteMcpServerState = {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly enabled: boolean;
  readonly status: RemoteMcpStatus;
  readonly toolCount: number;
  readonly retryable: boolean;
};

/** The state a server is drawn in, with every field named once. */
function stateOf(
  server: Pick<StoredRemoteMcpServer, 'id' | 'name' | 'url' | 'enabled'>,
  fields: {
    readonly status: RemoteMcpStatus;
    readonly toolCount: number;
    readonly retryable: boolean;
  }
): RemoteMcpServerState {
  return {
    id: server.id,
    name: server.name,
    url: server.url,
    enabled: server.enabled,
    status: fields.status,
    toolCount: fields.toolCount,
    retryable: fields.retryable,
  };
}

/**
 * The state of every stored server, joined with what has been discovered.
 *
 * A disabled server is always `idle` with no tools, whatever a stale entry
 * says: it is the list that decides, and the entry is left for `reconcile` to
 * drop. A server with no entry has not been asked yet. A failed discovery shows
 * as `failed` with no tools. A failed discovery and one that answered with no
 * tools are both retryable, so a screen never leaves a server that was asked
 * without tools and without a way to ask it again.
 */
export function remoteServerStates(
  servers: readonly StoredRemoteMcpServer[],
  discovered: ReadonlyMap<string, RemoteMcpDiscovery>
): RemoteMcpServerState[] {
  return servers.map(server => {
    if (!server.enabled) {
      return stateOf(server, { status: 'idle', toolCount: 0, retryable: false });
    }
    const found = discovered.get(server.id);
    if (found === undefined) {
      return stateOf(server, { status: 'idle', toolCount: 0, retryable: false });
    }
    if (found.signIn === true) {
      return stateOf(server, { status: 'signIn', toolCount: 0, retryable: false });
    }
    if (found.failed === true) {
      return stateOf(server, { status: 'failed', toolCount: 0, retryable: true });
    }
    const toolCount = found.tools.length;
    return stateOf(server, { status: 'ready', toolCount, retryable: toolCount === 0 });
  });
}

/** The same server, drawn as one whose discovery is running now. */
export function connectingOf(state: RemoteMcpServerState): RemoteMcpServerState {
  return stateOf(state, { status: 'connecting', toolCount: 0, retryable: false });
}

/**
 * The tools of the enabled servers that were discovered, in list order.
 *
 * A disabled server contributes nothing even if it has a cached entry, and a
 * failed discovery contributes nothing even when it answered with tools
 * earlier: the union is only ever a server the app can currently reach.
 */
export function remoteServerToolsFor(
  servers: readonly StoredRemoteMcpServer[],
  discovered: ReadonlyMap<string, RemoteMcpDiscovery>
): readonly Tool[] {
  return servers.flatMap(server => {
    const found = server.enabled ? discovered.get(server.id) : undefined;
    return found === undefined || found.failed === true ? [] : found.tools;
  });
}

/**
 * What a server's offered tools look like once kept: the tools themselves, the
 * view each one carries, and the server's own names, which is what a view calls
 * its tools by.
 */
export function discoveryOf(
  serverId: string,
  tools: readonly RemoteMcpOfferedTool[]
): RemoteMcpDiscovery {
  const views = new Map<string, RemoteMcpToolView>();
  for (const tool of tools) {
    const uri = tool.uiResourceUri;
    if (uri !== undefined) {
      views.set(tool.definition.name, {
        serverId,
        serverToolName: tool.serverToolName,
        resourceUri: uri,
      });
    }
  }
  return { tools, views, serverTools: tools.map(tool => tool.serverToolName) };
}

/**
 * The views the enabled servers' discovered tools carry, by the name the model
 * calls each tool by. A disabled or failed server contributes none, which is
 * the same rule its tools follow.
 */
export function remoteServerViewsFor(
  servers: readonly StoredRemoteMcpServer[],
  discovered: ReadonlyMap<string, RemoteMcpDiscovery>
): ReadonlyMap<string, RemoteMcpToolView> {
  const views = new Map<string, RemoteMcpToolView>();
  for (const server of servers) {
    const found = server.enabled ? discovered.get(server.id) : undefined;
    if (found !== undefined && found.failed !== true) {
      for (const [name, view] of found.views) {
        views.set(name, view);
      }
    }
  }
  return views;
}
