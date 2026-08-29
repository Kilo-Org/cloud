import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { RemoteMcpToolCallEvent } from '@/src/shared/agent-conversation';
import { isExecutionStopped, normalizeExecutionGuard } from '@/src/shared/agent-tool-results';
import type { ExecutionGuard } from '@/src/shared/agent-tool-results';
import type { RemoteMcpServer } from '@/src/shared/remote-mcp';
import type { RemoteMcpStorageArea } from '@/src/shared/remote-mcp-storage';
import type { RemoteMcpToolRoute } from '@/src/shared/remote-mcp-tools';
import {
  capRemoteMcpToolResult,
  MAX_REMOTE_MCP_RESULT_CHARS,
  resolveRemoteMcpToolRoute,
} from '@/src/shared/remote-mcp-tools';
import type { NormalizedEvalTabResult } from '@/src/shared/tab-debugger';
import { callRemoteMcpTool } from './remote-mcp-client';

type FetchLike = typeof fetch;

const getMcpErrorText = (result: CallToolResult): string => {
  const text = result.content
    .flatMap(part => (part.type === 'text' && part.text.length > 0 ? [part.text] : []))
    .join('\n');

  return text.length > 0 ? text : 'Remote MCP tool call failed.';
};

/*
 * Resolve the route + server snapshot, run the tool via the PLAIN fetch (never
 * the Kilo gateway fetch — that would leak the user's Kilo token to a third
 * party), and cap the result before it enters conversation history. Stale or
 * unavailable calls return a normal tool error rather than throwing.
 */
export const executeRemoteMcpToolCall = async ({
  event,
  executionGuard,
  fetch: fetchFn,
  routes,
  servers,
  signal,
  storageArea,
}: {
  readonly event: RemoteMcpToolCallEvent;
  readonly executionGuard?: ExecutionGuard | undefined;
  readonly fetch: FetchLike;
  readonly routes: ReadonlyMap<string, RemoteMcpToolRoute>;
  readonly servers: readonly RemoteMcpServer[];
  readonly signal?: AbortSignal | undefined;
  readonly storageArea?: RemoteMcpStorageArea | undefined;
}): Promise<NormalizedEvalTabResult> => {
  const guard = normalizeExecutionGuard(executionGuard, signal);
  guard();
  const resolution = resolveRemoteMcpToolRoute(routes, event.name);

  if (!resolution.ok) {
    return { effectsUncertain: false, error: resolution.error, ok: false };
  }

  const server = servers.find(candidate => candidate.id === resolution.route.serverId);

  if (server === undefined || !server.enabled || server.status !== 'connected') {
    return {
      effectsUncertain: false,
      error: `Remote MCP tool ${event.name} is no longer available.`,
      ok: false,
    };
  }

  try {
    guard();
    const raw = await callRemoteMcpTool({
      arguments: event.arguments,
      executionGuard: guard,
      fetch: fetchFn,
      route: resolution.route,
      server,
      ...(signal === undefined ? {} : { signal }),
      ...(storageArea === undefined ? {} : { storageArea }),
    });

    if (raw.isError === true) {
      return {
        effectsUncertain: false,
        error: getMcpErrorText(raw).slice(0, MAX_REMOTE_MCP_RESULT_CHARS),
        ok: false,
      };
    }

    return { effectsUncertain: false, ok: true, value: capRemoteMcpToolResult(raw) };
  } catch (error) {
    if (isExecutionStopped(error)) {
      throw error;
    }
    return {
      effectsUncertain: true,
      error: error instanceof Error ? error.message : 'Remote MCP tool call failed.',
      ok: false,
    };
  }
};
