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

  it('emits gateway definitions with the upstream title, verbatim description and input schema', () => {
    const definitions = createKiloBrowserToolDefinitions('dangerous');
    const entryByName = new Map(BROWSER_TOOL_CONTRACT.map(entry => [entry.name, entry]));

    for (const definition of definitions) {
      const upstreamName = definition.function.name.slice('kilo_'.length);
      const entry = entryByName.get(upstreamName);

      expect(entry).toBeDefined();
      expect(definition.type).toBe('function');
      expect(definition.function.description).toBe(
        `${String(entry?.title)}\n${String(entry?.description)}`
      );
      expect(definition.function.parameters).toStrictEqual(entry?.inputSchema);
    }
  });

  it('exports the ordered name lists the runners and the e2e fixture assert', () => {
    expect(KILO_BROWSER_TOOL_NAMES).toStrictEqual(allKiloNames);
    expect(KILO_SAFE_BROWSER_TOOL_NAMES).toStrictEqual(safeKiloNames);
  });
});
