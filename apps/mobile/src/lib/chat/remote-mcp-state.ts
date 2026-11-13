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
 * The servers whose discovery answered, in stored order, with what each
 * answered. A disabled server is left out whatever a cached entry says, because
 * it is the list that decides and the entry is left for `reconcile` to drop. A
 * server with no entry has not been asked yet, and a failed discovery is a
 * server the app cannot currently reach, so neither of them has an answer to
 * offer.
 */
function answeredServers(
  servers: readonly StoredRemoteMcpServer[],
  discovered: ReadonlyMap<string, RemoteMcpDiscovery>
): readonly (readonly [StoredRemoteMcpServer, RemoteMcpDiscovery])[] {
  const answered: (readonly [StoredRemoteMcpServer, RemoteMcpDiscovery])[] = [];
  for (const server of servers) {
    const found = server.enabled ? discovered.get(server.id) : undefined;
    if (found !== undefined && found.failed !== true) {
      answered.push([server, found]);
    }
  }
  return answered;
}

/**
 * The tools of the enabled servers that were discovered, in list order.
 *
 * A disabled server contributes nothing even if it has a cached entry, and a
 * failed discovery contributes nothing even when it answered with tools
 * earlier: the union is only ever a server the app can currently reach.
 *
 * A tool name has one owner. Two servers can offer the same name, because the
 * server names its tools itself and the harness only prefixes them, so the list
 * keeps the first tool for each name and leaves the later ones out. A call is
 * resolved against the first tool with its name, so this is the list it answers
 * from: what the model is offered and what it gets back are one set.
 */
export function remoteServerToolsFor(
  servers: readonly StoredRemoteMcpServer[],
  discovered: ReadonlyMap<string, RemoteMcpDiscovery>
): readonly Tool[] {
  const tools: Tool[] = [];
  const seen = new Set<string>();
  for (const [, found] of answeredServers(servers, discovered)) {
    for (const tool of found.tools) {
      const name = tool.definition.name;
      if (!seen.has(name)) {
        seen.add(name);
        tools.push(tool);
      }
    }
  }
  return tools;
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
 *
 * The name has the one owner the tool list gave it: the first server to offer
 * it. The seen set covers every tool a server offers, not only the ones that
 * carry a view, so a shadowed tool leaves no view behind even when the tool
 * that survives it carries none, and a later server's view never replaces an
 * earlier server's.
 */
export function remoteServerViewsFor(
  servers: readonly StoredRemoteMcpServer[],
  discovered: ReadonlyMap<string, RemoteMcpDiscovery>
): ReadonlyMap<string, RemoteMcpToolView> {
  const views = new Map<string, RemoteMcpToolView>();
  const seen = new Set<string>();
  for (const [, found] of answeredServers(servers, discovered)) {
    for (const tool of found.tools) {
      const name = tool.definition.name;
      if (!seen.has(name)) {
        seen.add(name);
        const view = found.views.get(name);
        if (view !== undefined) {
          views.set(name, view);
        }
      }
    }
  }
  return views;
}
