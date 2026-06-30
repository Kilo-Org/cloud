import type { RemoteMcpToolCallEvent } from '@/src/shared/agent-conversation';
import type { RemoteMcpServer } from '@/src/shared/remote-mcp';
import type { RemoteMcpStorageArea } from '@/src/shared/remote-mcp-storage';
import type { RemoteMcpToolRoute } from '@/src/shared/remote-mcp-tools';
import {
  capRemoteMcpToolResult,
  resolveRemoteMcpToolRoute,
} from '@/src/shared/remote-mcp-tools';
import type { EvalTabResult } from '@/src/shared/tab-debugger';
import { callRemoteMcpTool } from './remote-mcp-client';

type FetchLike = typeof fetch;

const isMcpErrorResult = (value: unknown): value is { content: unknown } =>
  typeof value === 'object' && value !== null && 'isError' in value && value.isError === true;

const getContentPartText = (part: unknown): string =>
  typeof part === 'object' && part !== null && 'text' in part && typeof part.text === 'string'
    ? part.text
    : '';

const getMcpErrorText = (value: { content: unknown }): string => {
  const { content } = value;

  if (Array.isArray(content)) {
    const text = content
      .map(part => getContentPartText(part))
      .filter(part => part.length > 0)
      .join('\n');

    if (text.length > 0) {
      return text;
    }
  }

  return 'Remote MCP tool call failed.';
};

/*
 * Resolve the route + server snapshot, run the tool via the PLAIN fetch (never
 * the Kilo gateway fetch — that would leak the user's Kilo token to a third
 * party), and cap the result before it enters conversation history. Stale or
 * unavailable calls return a normal tool error rather than throwing.
 */
export const executeRemoteMcpToolCall = async ({
  event,
  fetch: fetchFn,
  routes,
  servers,
  signal,
  storageArea,
}: {
  readonly event: RemoteMcpToolCallEvent;
  readonly fetch: FetchLike;
  readonly routes: ReadonlyMap<string, RemoteMcpToolRoute>;
  readonly servers: readonly RemoteMcpServer[];
  readonly signal?: AbortSignal | undefined;
  readonly storageArea?: RemoteMcpStorageArea | undefined;
}): Promise<EvalTabResult> => {
  const resolution = resolveRemoteMcpToolRoute(routes, event.name);

  if (!resolution.ok) {
    return { error: resolution.error, ok: false };
  }

  const server = servers.find(candidate => candidate.id === resolution.route.serverId);

  if (server === undefined || !server.enabled || server.status !== 'connected') {
    return { error: `Remote MCP tool ${event.name} is no longer available.`, ok: false };
  }

  const raw = await callRemoteMcpTool({
    arguments: event.arguments,
    fetch: fetchFn,
    route: resolution.route,
    server,
    ...(signal === undefined ? {} : { signal }),
    ...(storageArea === undefined ? {} : { storageArea }),
  });

  if (isMcpErrorResult(raw)) {
    return { error: getMcpErrorText(raw), ok: false };
  }

  return { ok: true, value: capRemoteMcpToolResult(raw) };
};
