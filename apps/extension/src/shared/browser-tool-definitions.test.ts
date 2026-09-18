import { describe, expect, it } from 'vitest';
import {
  KILO_BROWSER_TOOL_NAMES,
  KILO_SAFE_BROWSER_TOOL_NAMES,
  createKiloBrowserToolDefinitions,
} from './browser-tool-definitions';
import { BROWSER_TOOL_CONTRACT, toKiloBrowserToolName } from './browser-tool-contract';

const allKiloNames = BROWSER_TOOL_CONTRACT.map(entry => toKiloBrowserToolName(entry.name));
const safeKiloNames = BROWSER_TOOL_CONTRACT.filter(entry => entry.readOnly).map(entry =>
  toKiloBrowserToolName(entry.name)
);

// A bare upstream sibling reference: `browser_snapshot` not preceded by the `kilo_` prefix.
const bareToolReference = new RegExp(
  `(?<!kilo_)\\b(?:${BROWSER_TOOL_CONTRACT.map(entry => entry.name).join('|')})\\b`
);

/*
 * Strip every description so an exposed schema can be compared on structure,
 * types and constraints without duplicating the description rewrite.
 */
const withoutDescriptions = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(item => withoutDescriptions(item));
  }

  if (typeof value !== 'object' || value === null) {
    return value;
  }

  const entries: [string, unknown][] = Object.entries(value);
  const result: Record<string, unknown> = {};

  for (const [key, fieldValue] of entries) {
    if (key !== 'description') {
      result[key] = withoutDescriptions(fieldValue);
    }
  }

  return result;
};

describe('kilo browser tool definitions', () => {
  it('returns the eight read-only entries in upstream order for safe mode', () => {
    const definitions = createKiloBrowserToolDefinitions('safe');

    expect(definitions.map(definition => definition.function.name)).toStrictEqual(safeKiloNames);
    expect(safeKiloNames).toHaveLength(8);
  });

  it('returns all twenty-six entries in upstream order for danger mode', () => {
    const definitions = createKiloBrowserToolDefinitions('dangerous');

    expect(definitions.map(definition => definition.function.name)).toStrictEqual(allKiloNames);
    expect(allKiloNames).toHaveLength(26);
  });

  it('never returns a browser definition outside the contract', () => {
    const names = new Set(
      [
        ...createKiloBrowserToolDefinitions('safe'),
        ...createKiloBrowserToolDefinitions('dangerous'),
      ].map(definition => definition.function.name)
    );

    expect([...names].toSorted()).toStrictEqual([...new Set(allKiloNames)].toSorted());
    for (const name of names) {
      expect(name.startsWith('kilo_browser_')).toBe(true);
    }
  });

  it('emits gateway definitions with the upstream title and the vendored input schema', () => {
    const definitions = createKiloBrowserToolDefinitions('dangerous');
    const entryByName = new Map(BROWSER_TOOL_CONTRACT.map(entry => [entry.name, entry]));

    for (const definition of definitions) {
      const upstreamName = definition.function.name.slice('kilo_'.length);
      const entry = entryByName.get(upstreamName);

      expect(entry).toBeDefined();
      expect(definition.type).toBe('function');
      expect(definition.function.description.startsWith(`${String(entry?.title)}\n`)).toBe(true);
      expect(withoutDescriptions(definition.function.parameters)).toStrictEqual(
        withoutDescriptions(entry?.inputSchema)
      );
    }
  });

  it('rewrites every bare upstream sibling reference to its exposed kilo_ name', () => {
    const definitions = createKiloBrowserToolDefinitions('dangerous');
    const definitionByName = new Map(
      definitions.map(definition => [definition.function.name, definition.function])
    );

    for (const definition of definitions) {
      expect(JSON.stringify(definition.function)).not.toMatch(bareToolReference);
    }

    expect(definitionByName.get('kilo_browser_network_requests')?.description).toContain(
      'Use kilo_browser_network_request with the number'
    );
    expect(definitionByName.get('kilo_browser_network_request')?.description).toContain(
      'Use the number from kilo_browser_network_requests'
    );
    expect(definitionByName.get('kilo_browser_take_screenshot')?.description).toContain(
      'use kilo_browser_snapshot for actions'
    );

    // References inside input-schema property descriptions are rewritten too.
    expect(JSON.stringify(definitionByName.get('kilo_browser_webmcp_call')?.parameters)).toContain(
      'kilo_browser_webmcp_list'
    );
    expect(
      JSON.stringify(definitionByName.get('kilo_browser_network_request')?.parameters)
    ).toContain('kilo_browser_network_requests');
  });

  it('exports the ordered name lists the runners and the e2e fixture assert', () => {
    expect(KILO_BROWSER_TOOL_NAMES).toStrictEqual(allKiloNames);
    expect(KILO_SAFE_BROWSER_TOOL_NAMES).toStrictEqual(safeKiloNames);
  });
});
