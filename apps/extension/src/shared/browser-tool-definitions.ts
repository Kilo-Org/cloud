import type { AgentMode } from './agent-conversation';
import {
  BROWSER_TOOL_CONTRACT,
  KILO_BROWSER_TOOL_PREFIX,
  toKiloBrowserToolName,
} from './browser-tool-contract';
import type { BrowserToolContractEntry, KiloBrowserToolName } from './browser-tool-contract';
import type { KiloGatewayToolDefinition } from './kilo-api-client';

/*
 * The model-facing browser tool set: the vendored Playwright MCP contract,
 * emitted in upstream order under the `kilo_` name prefix. Safe mode exposes
 * only the entries the upstream server marks read-only; danger mode exposes
 * every entry. No other browser definition is ever returned.
 */

export { KILO_BROWSER_TOOL_NAMES } from './browser-tool-contract';

const isKiloBrowserToolName = (name: string): name is KiloBrowserToolName =>
  name.startsWith(`${KILO_BROWSER_TOOL_PREFIX}browser_`);

const toDefinition = (entry: BrowserToolContractEntry): KiloGatewayToolDefinition => {
  const name = toKiloBrowserToolName(entry.name);

  if (!isKiloBrowserToolName(name)) {
    // Unreachable while the generated contract holds (browser-tool-contract.test.ts pins the names).
    throw new Error(`Browser tool contract entry "${entry.name}" is not a browser_ tool.`);
  }

  return {
    function: {
      description: `${entry.title}\n${entry.description}`,
      name,
      parameters: entry.inputSchema,
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
