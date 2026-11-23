import { z } from 'zod';
import type { WebMcpToolCallEvent } from './agent-conversation';
import { originPatternMatches } from './browser-agent-checks';
import { KILO_BROWSER_TOOL_PREFIX } from './browser-tool-contract';
import type { KiloGatewayToolDefinition, WebMcpGatewayToolName } from './kilo-gateway-chat-client';
import { discoverWebMcpToolsInTab, executeWebMcpToolInTab } from './tab-debugger';
import type {
  BrowserScriptingApi,
  EvalTabResult,
  WebMcpDiscoveryResult,
  WebMcpToolDescriptor,
} from './tab-debugger';

const webMcpDiscoveryValueSchema = z.object({
  documentId: z.string(),
  tools: z.array(
    z.object({
      description: z.string(),
      inputSchema: z.unknown(),
      name: z.string(),
      origin: z.string(),
      title: z.string(),
    })
  ),
});

/**
 * The two WebMCP hooks the page-family handlers take for
 * `browser_webmcp_list`/`browser_webmcp_call`, wired to the same injected
 * discovery/execution helpers the standalone WebMCP messages use, so the panel,
 * a workflow and a CLI agent all reach the page the same way. The execution
 * hook is signature-checked inside the page before anything runs there. Both
 * are `undefined` when the tab scripting API is missing.
 */
export interface WebMcpDispatchHooks {
  readonly webMcpDiscover:
    | ((tabId: number) => Promise<WebMcpDiscoveryResult | undefined>)
    | undefined;
  readonly webMcpExecute: ((event: WebMcpToolCallEvent) => Promise<EvalTabResult>) | undefined;
}

export const webMcpDispatchHooks = (
  scriptingApi: BrowserScriptingApi | undefined
): WebMcpDispatchHooks => ({
  webMcpDiscover:
    scriptingApi === undefined
      ? undefined
      : async (tabId: number): Promise<WebMcpDiscoveryResult | undefined> => {
          const discovery = await discoverWebMcpToolsInTab({ scriptingApi, tabId });

          if (!discovery.ok) {
            return undefined;
          }

          const parsed = webMcpDiscoveryValueSchema.safeParse(discovery.value);

          return parsed.success ? parsed.data : undefined;
        },
  webMcpExecute:
    scriptingApi === undefined
      ? undefined
      : (event: WebMcpToolCallEvent): Promise<EvalTabResult> =>
          executeWebMcpToolInTab({
            arguments: JSON.stringify(event.arguments),
            definitionSignature: event.definitionSignature,
            documentId: event.documentId,
            scriptingApi,
            tabId: event.tabId,
            toolName: event.name,
          }),
});

/**
 * The WebMCP tools `browser_webmcp_list` shows. A descriptor that names no
 * origin is withheld from every caller — panel or agent — because
 * `browser_webmcp_call` refuses one, so listing it would offer a tool that call
 * cannot run. An agent caller additionally sees only the descriptors whose
 * origin it holds `read` for: the list is page text, shown under the origin the
 * page claims and withheld when that origin cannot be read. Both browser-tool
 * list paths filter here, so a withheld tool is never reported with its count.
 * The panel's own gateway tools are built by `buildWebMcpToolDefinitions` and
 * keep their own rules.
 */
export const readableWebMcpTools = (
  tools: readonly WebMcpToolDescriptor[],
  readableOrigins: readonly string[] | undefined
): readonly WebMcpToolDescriptor[] =>
  tools.filter(
    tool =>
      tool.origin !== '' &&
      (readableOrigins === undefined ||
        readableOrigins.some(pattern => originPatternMatches(pattern, tool.origin)))
  );

export interface WebMcpToolRoute {
  readonly tabId: number;
  readonly documentId: string;
  readonly origin: string;
  readonly definitionSignature: string;
}

export interface WebMcpToolBuildResult {
  readonly routes: ReadonlyMap<string, WebMcpToolRoute>;
  readonly tools: KiloGatewayToolDefinition[];
  readonly warning?: string | undefined;
}

const MAX_WEB_MCP_TOOLS = 128;
const pageNamePattern = /^[A-Za-z0-9_-]+$/;

const RESERVED_GATEWAY_TOOL_NAMES = new Set([
  'delete_workflow',
  'get_memory',
  'get_workflow',
  'run_workflow',
  'save_memory',
  'save_workflow',
  'search_memories',
  'search_workflows',
  'web_search',
]);

const stringSchema = z.string();
const jsonRecordSchema = z.record(z.string(), z.unknown());

const normalizeString = (value: unknown): string => {
  const result = stringSchema.safeParse(value);
  return result.success ? result.data : '';
};

const normalizeInputSchema = (inputSchema: unknown): Record<string, unknown> | undefined => {
  let schema: unknown = inputSchema;

  const asString = stringSchema.safeParse(schema);
  if (asString.success) {
    try {
      schema = JSON.parse(asString.data) as unknown;
    } catch {
      return undefined;
    }
  }

  const asRecord = jsonRecordSchema.safeParse(schema);
  return asRecord.success ? asRecord.data : undefined;
};

const isReservedName = (name: string): boolean =>
  RESERVED_GATEWAY_TOOL_NAMES.has(name) ||
  name.startsWith('mcp_') ||
  // A page must never offer a tool the browser set owns: the name would collide in the gateway request and shadow the real effect.
  name.startsWith(`${KILO_BROWSER_TOOL_PREFIX}browser_`);

const buildDescription = (title: string, description: string): string => {
  if (title !== '' && description !== '') {
    return `${title}\n${description}`;
  }

  return title === '' ? description : title;
};

const isWebMcpGatewayToolName = (name: string): name is WebMcpGatewayToolName =>
  pageNamePattern.test(name) && !isReservedName(name);

/*
 * The signature is compared against one rebuilt inside the page, and extension
 * messaging reorders object keys, so both sides sort keys before comparing:
 * JSON key order is not part of a tool definition.
 */
// oxlint-disable-next-line anti-slop/no-unknown-returns -- recursive canonicalizer over arbitrary third-party tool data: it mirrors an unknown input, so no narrower named type can describe the output.
const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(entry => canonicalize(entry));
  }

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- the descriptor's schema travels as untyped tool data, so this is the boundary that decides whether to canonicalize it.
  if (value === null || typeof value !== 'object') {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .toSorted(([left], [right]) => (left < right ? -1 : Number(left > right)))
      .map(([key, entry]) => [key, canonicalize(entry)])
  );
};

export const buildWebMcpDefinitionSignature = ({
  description,
  inputSchema,
  name,
  origin,
  title,
}: {
  readonly description: string;
  readonly inputSchema: unknown;
  readonly name: string;
  readonly origin: string;
  readonly title: string;
}): string =>
  JSON.stringify(
    canonicalize([
      normalizeString(name),
      normalizeString(title),
      normalizeString(description),
      normalizeString(origin),
      normalizeInputSchema(inputSchema),
    ])
  );

export const buildWebMcpToolDefinitions = ({
  tabId,
  documentId,
  tools,
}: {
  readonly tabId: number;
  readonly documentId: string;
  readonly tools: readonly WebMcpToolDescriptor[];
}): WebMcpToolBuildResult => {
  if (tools.length > MAX_WEB_MCP_TOOLS) {
    return {
      routes: new Map(),
      tools: [],
      warning: `WebMCP exposes ${tools.length} tools; the limit is ${MAX_WEB_MCP_TOOLS}. No WebMCP tools were enabled for this turn.`,
    };
  }

  const routes = new Map<string, WebMcpToolRoute>();
  const gatewayTools: KiloGatewayToolDefinition[] = [];
  const omittedNames: string[] = [];
  const seenNames = new Set<string>();

  for (const tool of tools) {
    const name = normalizeString(tool.name);
    const normalizedSchema = normalizeInputSchema(tool.inputSchema);

    const hasInvalidName = !isWebMcpGatewayToolName(name) || seenNames.has(name);

    if (hasInvalidName || normalizedSchema === undefined) {
      omittedNames.push(name);
    } else {
      seenNames.add(name);

      const title = normalizeString(tool.title);
      const description = normalizeString(tool.description);
      const origin = normalizeString(tool.origin);
      const definitionSignature = buildWebMcpDefinitionSignature(tool);

      routes.set(name, {
        definitionSignature,
        documentId,
        origin,
        tabId,
      });
      gatewayTools.push({
        function: {
          description: buildDescription(title, description),
          name,
          parameters: normalizedSchema,
        },
        type: 'function',
      });
    }
  }

  return {
    routes,
    tools: gatewayTools,
    ...(omittedNames.length > 0
      ? { warning: `Omitted ${omittedNames.length} WebMCP tool(s): ${omittedNames.join(', ')}.` }
      : {}),
  };
};
