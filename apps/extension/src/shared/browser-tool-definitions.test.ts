import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { dropPathsSchema, dropTargetSchema } from './browser-agent-checks';
import { createKiloBrowserToolDefinitions } from './browser-tool-definitions';
import { BROWSER_TOOL_CONTRACT, toKiloBrowserToolName } from './browser-tool-contract';
import type { BrowserToolContractEntry, BrowserToolInputSchema } from './browser-tool-contract';

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

/*
 * What a model is told for a contract entry: the vendored schema, except that
 * `browser_drop`'s `paths` entries and `target` are the non-empty strings its
 * handlers accept. Written out here, from the contract, so this spec states the
 * rule instead of importing the producer it checks.
 */
const jsonObjectSchema = z.record(z.string(), z.unknown());

const propertiesOf = (schema: unknown): Record<string, unknown> =>
  z.object({ properties: jsonObjectSchema }).parse(schema).properties;

const publishedSchema = (entry: BrowserToolContractEntry): BrowserToolInputSchema => {
  if (entry.name !== 'browser_drop') {
    return entry.inputSchema;
  }

  const paths = jsonObjectSchema.parse(entry.inputSchema.properties['paths']);
  const target = jsonObjectSchema.parse(entry.inputSchema.properties['target']);

  return {
    ...entry.inputSchema,
    properties: {
      ...entry.inputSchema.properties,
      paths: { ...paths, items: { minLength: 1, type: 'string' } },
      target: { ...target, minLength: 1, type: 'string' },
    },
  };
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

  it('emits gateway definitions with the upstream title and the published input schema', () => {
    const definitionByName = new Map(
      createKiloBrowserToolDefinitions('dangerous').map(
        definition => [String(definition.function.name), definition] as const
      )
    );
    const definitionSchema = z.object({
      function: z.object({
        description: z.string(),
        name: z.string(),
        parameters: z.unknown(),
      }),
      type: z.literal('function'),
    });

    expect([...definitionByName.keys()]).toStrictEqual(allKiloNames);

    for (const entry of BROWSER_TOOL_CONTRACT) {
      const definition = definitionSchema.parse(
        definitionByName.get(toKiloBrowserToolName(entry.name))
      );

      expect(definition.function.description.startsWith(`${entry.title}\n`)).toBe(true);
      expect(withoutDescriptions(definition.function.parameters)).toStrictEqual(
        withoutDescriptions(publishedSchema(entry))
      );
    }
  });

  it('publishes the non-empty path rule the browser_drop handler enforces', () => {
    const definitions = createKiloBrowserToolDefinitions('dangerous');
    const drop = definitions.find(definition => definition.function.name === 'kilo_browser_drop');
    const publishedPaths = z
      .object({
        description: z.string(),
        items: z.record(z.string(), z.unknown()),
      })
      .parse(propertiesOf(drop?.function.parameters)['paths']);

    // The schema a model reads states the rule the call applies, read from the schema the handler parses.
    expect(publishedPaths.items).toStrictEqual(
      z
        .object({ items: z.record(z.string(), z.unknown()) })
        .parse(z.toJSONSchema(dropPathsSchema, { io: 'input' })).items
    );
    expect(publishedPaths.description).toContain('empty entry is not allowed');
  });

  it('publishes the non-empty target rule the browser_drop handler enforces', () => {
    const definitions = createKiloBrowserToolDefinitions('dangerous');
    const drop = definitions.find(definition => definition.function.name === 'kilo_browser_drop');
    const vendoredTarget = z
      .record(z.string(), z.unknown())
      .parse(
        z
          .object({ properties: z.record(z.string(), z.unknown()) })
          .parse(BROWSER_TOOL_CONTRACT.find(entry => entry.name === 'browser_drop')?.inputSchema)
          .properties['target']
      );
    const publishedTarget = z
      .object({ description: z.string() })
      .catchall(z.unknown())
      .parse(propertiesOf(drop?.function.parameters)['target']);
    // The rule the drop handlers apply, read from the schema they parse rather than copied from the producer.
    const targetRule = z
      .object({ minLength: z.number(), type: z.string() })
      .parse(z.toJSONSchema(dropTargetSchema, { io: 'input' }));

    // The published target keeps the vendored wording and states the rule the call applies.
    expect(publishedTarget).toStrictEqual({ ...vendoredTarget, ...targetRule });
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
});
