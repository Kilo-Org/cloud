import { z } from 'zod';
import { KILO_BROWSER_TOOL_PREFIX } from './browser-tool-contract';
import type { KiloGatewayToolDefinition, WebMcpGatewayToolName } from './kilo-gateway-chat-client';
import type { WebMcpToolDescriptor } from './tab-debugger';

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
