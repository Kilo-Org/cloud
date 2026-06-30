import type { AgentMode } from './agent-conversation';
import type { KiloGatewayToolDefinition } from './kilo-api-client';
import type { RemoteMcpCachedTool, RemoteMcpServer } from './remote-mcp';

export interface RemoteMcpToolRoute {
  readonly gatewayToolName: string;
  readonly remoteToolName: string;
  readonly serverId: string;
  readonly serverName: string;
}

export interface RemoteMcpToolBuildResult {
  readonly routes: ReadonlyMap<string, RemoteMcpToolRoute>;
  readonly tools: KiloGatewayToolDefinition[];
  readonly warning?: string | undefined;
}

export type RemoteMcpToolRouteResolution =
  | { readonly ok: true; readonly route: RemoteMcpToolRoute }
  | { readonly error: string; readonly ok: false };
type RemoteMcpGatewayToolName = `mcp_${string}`;

const MAX_REMOTE_MCP_TOOLS = 128;
export const MAX_REMOTE_MCP_RESULT_CHARS = 64 * 1024;
const sourceNamePattern = /^[a-zA-Z0-9_-]+$/;

const isObjectSchema = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  'type' in value &&
  value.type === 'object';

const isModeAllowedServer = (mode: AgentMode, server: RemoteMcpServer): boolean =>
  server.enabled &&
  server.status === 'connected' &&
  (mode === 'dangerous' || server.allowInSafeMode);

const getMappedToolName = (
  server: RemoteMcpServer,
  tool: RemoteMcpCachedTool
): RemoteMcpGatewayToolName | undefined => {
  if (!sourceNamePattern.test(server.slug) || !sourceNamePattern.test(tool.name)) {
    return undefined;
  }

  return `mcp_${server.slug}_${tool.name}`;
};

const toGatewayToolDefinition = (
  name: RemoteMcpGatewayToolName,
  server: RemoteMcpServer,
  tool: RemoteMcpCachedTool
): KiloGatewayToolDefinition => ({
  function: {
    description:
      tool.description === undefined || tool.description.length === 0
        ? `Run ${tool.name} on ${server.displayName}.`
        : tool.description,
    name,
    parameters: tool.inputSchema,
  },
  type: 'function',
});

export const buildRemoteMcpToolDefinitions = ({
  mode,
  servers,
}: {
  readonly mode: AgentMode;
  readonly servers: readonly RemoteMcpServer[];
}): RemoteMcpToolBuildResult => {
  const candidates = servers
    .filter(server => isModeAllowedServer(mode, server))
    .flatMap(server =>
      server.cachedTools.map(tool => ({
        mappedName: getMappedToolName(server, tool),
        server,
        tool,
      }))
    );

  if (candidates.length > MAX_REMOTE_MCP_TOOLS) {
    return {
      routes: new Map(),
      tools: [],
      warning: `Remote MCP exposes ${candidates.length} tools; the limit is ${MAX_REMOTE_MCP_TOOLS}. No remote MCP tools were enabled for this turn.`,
    };
  }

  const mappedNameCounts = new Map<string, number>();
  for (const candidate of candidates) {
    if (candidate.mappedName !== undefined) {
      mappedNameCounts.set(
        candidate.mappedName,
        (mappedNameCounts.get(candidate.mappedName) ?? 0) + 1
      );
    }
  }

  const routes = new Map<string, RemoteMcpToolRoute>();
  const tools: KiloGatewayToolDefinition[] = [];

  // Keep only tools with a unique, valid gateway name and an object input schema.
  for (const { mappedName, server, tool } of candidates) {
    if (
      mappedName !== undefined &&
      (mappedNameCounts.get(mappedName) ?? 0) === 1 &&
      isObjectSchema(tool.inputSchema)
    ) {
      routes.set(mappedName, {
        gatewayToolName: mappedName,
        remoteToolName: tool.name,
        serverId: server.id,
        serverName: server.displayName,
      });
      tools.push(toGatewayToolDefinition(mappedName, server, tool));
    }
  }

  return { routes, tools };
};

export const resolveRemoteMcpToolRoute = (
  routes: ReadonlyMap<string, RemoteMcpToolRoute>,
  gatewayToolName: string
): RemoteMcpToolRouteResolution => {
  const route = routes.get(gatewayToolName);

  return route === undefined
    ? { error: `Remote MCP tool ${gatewayToolName} is no longer available.`, ok: false }
    : { ok: true, route };
};

export const capRemoteMcpToolResult = (value: unknown): unknown => {
  const serialized = JSON.stringify(value);

  if (serialized === undefined || serialized.length <= MAX_REMOTE_MCP_RESULT_CHARS) {
    return value;
  }

  return {
    truncated: true,
    value: serialized.slice(0, MAX_REMOTE_MCP_RESULT_CHARS),
  };
};
