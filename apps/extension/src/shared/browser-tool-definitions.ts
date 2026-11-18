import type { AgentMode } from './agent-conversation';
import {
  BROWSER_TOOL_CONTRACT,
  KILO_BROWSER_TOOL_PREFIX,
  toKiloBrowserToolName,
} from './browser-tool-contract';
import type {
  BrowserToolContractEntry,
  BrowserToolInputSchema,
  KiloBrowserToolName,
} from './browser-tool-contract';
import type { KiloGatewayToolDefinition } from './kilo-api-client';

/*
 * The model-facing browser tool set: the vendored Playwright MCP contract,
 * emitted in upstream order under the `kilo_` name prefix. Safe mode exposes
 * only the entries the upstream server marks read-only; danger mode exposes
 * every entry. No other browser definition is ever returned.
 *
 * Some upstream descriptions name sibling tools by their bare `browser_*`
 * names ("use browser_snapshot for actions"). Those names are never exposed, so
 * a model that follows the description would call a tool the side panel does
 * not route and the call would disappear without a result. Every exposed
 * definition therefore rewrites those references to the exposed
 * `kilo_browser_*` names while the vendored contract itself stays verbatim.
 */

export { KILO_BROWSER_TOOL_NAMES } from './browser-tool-contract';

const isKiloBrowserToolName = (name: string): name is KiloBrowserToolName =>
  name.startsWith(`${KILO_BROWSER_TOOL_PREFIX}browser_`);

// Longest first so `browser_network_requests` wins over `browser_network_request`.
// The word boundaries keep `kilo_browser_click` from matching a prefixed name.
const BROWSER_TOOL_NAME_REFERENCE = new RegExp(
  `\\b(?:${BROWSER_TOOL_CONTRACT.map(entry => entry.name)
    .toSorted((left, right) => right.length - left.length)
    .join('|')})\\b`,
  'g'
);

const prefixToolNameReferences = (text: string): string =>
  text.replace(BROWSER_TOOL_NAME_REFERENCE, match => toKiloBrowserToolName(match));

/*
 * Rewrite every `description` string in the emitted JSON schema — property,
 * nested item and nested property descriptions included — and leave the schema
 * structure, types and constraints exactly as vendored.
 */
// oxlint-disable-next-line anti-slop/no-unknown-returns -- mirrors the untyped JSON-schema value it walks
const prefixDescriptionReferences = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(item => prefixDescriptionReferences(item));
  }

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- JSON-schema leaf guard on untyped upstream data
  if (typeof value !== 'object' || value === null) {
    return value;
  }

  const entries: [string, unknown][] = Object.entries(value);
  const result: Record<string, unknown> = {};

  for (const [key, fieldValue] of entries) {
    result[key] =
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- a description carries prose only when it is a string
      key === 'description' && typeof fieldValue === 'string'
        ? prefixToolNameReferences(fieldValue)
        : prefixDescriptionReferences(fieldValue);
  }

  // oxlint-disable-next-line anti-slop/no-known-value-widening -- mirrors the untyped JSON-schema value it walks
  return result;
};

const withPrefixedProperties = (properties: Record<string, unknown>) => {
  const result: Record<string, unknown> = {};

  for (const [name, property] of Object.entries(properties)) {
    result[name] = prefixDescriptionReferences(property);
  }

  return result;
};

const withPrefixedSchemaDescriptions = (
  schema: BrowserToolInputSchema
): BrowserToolInputSchema => ({
  ...schema,
  properties: withPrefixedProperties(schema.properties),
});

const toDefinition = (entry: BrowserToolContractEntry): KiloGatewayToolDefinition => {
  const name = toKiloBrowserToolName(entry.name);

  if (!isKiloBrowserToolName(name)) {
    // Unreachable while the generated contract holds (browser-tool-contract.test.ts pins the names).
    throw new Error(`Browser tool contract entry "${entry.name}" is not a browser_ tool.`);
  }

  return {
    function: {
      description: `${entry.title}\n${prefixToolNameReferences(entry.description)}`,
      name,
      parameters: withPrefixedSchemaDescriptions(entry.inputSchema),
    },
    type: 'function',
  };
};

const entriesFor = (mode: AgentMode): readonly BrowserToolContractEntry[] =>
  mode === 'dangerous'
    ? BROWSER_TOOL_CONTRACT
    : BROWSER_TOOL_CONTRACT.filter(entry => entry.readOnly);

export const createKiloBrowserToolDefinitions = (mode: AgentMode): KiloGatewayToolDefinition[] =>
  entriesFor(mode).map(entry => toDefinition(entry));

/** The prefixed read-only browser tool names, in upstream order — the safe-mode browser set. */
export const KILO_SAFE_BROWSER_TOOL_NAMES: readonly string[] = BROWSER_TOOL_CONTRACT.filter(
  entry => entry.readOnly
).map(entry => toKiloBrowserToolName(entry.name));
