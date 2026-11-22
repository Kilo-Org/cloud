import { type JsonSchema } from '@kilocode/harness-sdk';
import { settingsTools } from '@kilocode/harness-sdk/plugins/tools';
import { describe, expect, it, vi } from 'vitest';

import { nativeSchemaOf, nativeTools, omittedTools } from './native-tool-schema';

const tool = (parameters: JsonSchema) => ({ name: 'tool', description: 'A tool', parameters });

describe('native tool schema', () => {
  it('converts every supported type, with descriptions, choices, and array bounds', () => {
    expect(
      nativeSchemaOf(
        tool({
          type: 'object',
          properties: {
            city: { type: 'string', description: 'City name' },
            unit: { type: 'string', enum: ['celsius', 'fahrenheit'] },
            days: { type: 'integer' },
            ratio: { type: 'number' },
            exact: { type: 'boolean' },
            tags: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 3 },
            where: {
              type: 'object',
              description: 'A place',
              properties: { lat: { type: 'number' } },
              required: ['lat'],
            },
          },
          required: ['city'],
        })
      )
    ).toEqual({
      ok: true,
      omitted: [],
      schema: {
        type: 'object',
        properties: [
          {
            name: 'city',
            description: 'City name',
            optional: false,
            schema: { type: 'string', description: 'City name' },
          },
          {
            name: 'unit',
            optional: true,
            schema: { type: 'string', choices: ['celsius', 'fahrenheit'] },
          },
          { name: 'days', optional: true, schema: { type: 'integer' } },
          { name: 'ratio', optional: true, schema: { type: 'number' } },
          { name: 'exact', optional: true, schema: { type: 'boolean' } },
          {
            name: 'tags',
            optional: true,
            schema: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 3 },
          },
          {
            name: 'where',
            description: 'A place',
            optional: true,
            schema: {
              type: 'object',
              description: 'A place',
              properties: [{ name: 'lat', optional: false, schema: { type: 'number' } }],
            },
          },
        ],
      },
    });
  });

  it('reads a nullable value as the value itself, in both spellings', () => {
    const converted = nativeSchemaOf(
      tool({
        type: 'object',
        properties: {
          listed: { type: ['string', 'null'] },
          union: { anyOf: [{ type: 'integer' }, { type: 'null' }], description: 'Kept' },
        },
        required: ['listed', 'union'],
      })
    );
    expect(converted.ok && converted.schema).toEqual({
      type: 'object',
      properties: [
        { name: 'listed', optional: false, schema: { type: 'string' } },
        {
          name: 'union',
          description: 'Kept',
          optional: false,
          schema: { type: 'integer', description: 'Kept' },
        },
      ],
    });
  });

  it('accepts a tool with no arguments', () => {
    expect(nativeSchemaOf(tool({ type: 'object', properties: {} }))).toEqual({
      ok: true,
      omitted: [],
      schema: { type: 'object', properties: [] },
    });
  });

  it.each([
    ['a real union', { anyOf: [{ type: 'string' }, { type: 'number' }] }, 'value: anyOf'],
    ['a type list', { type: ['string', 'number'] }, 'value: a type list'],
    ['a reference', { $ref: '#/$defs/value' }, 'value: $ref'],
    ['an intersection', { allOf: [{ type: 'string' }] }, 'value: allOf'],
    ['a constant', { type: 'string', const: 'x' }, 'value: const'],
    [
      'a number enum',
      { type: 'integer', enum: [1, 2] },
      'value: an enum that is not a list of strings',
    ],
    ['an empty enum', { enum: [] }, 'value: an enum that is not a list of strings'],
    [
      'a tuple',
      { type: 'array', items: [{ type: 'string' }] },
      'value: an array without one item schema',
    ],
    ['an array without items', { type: 'array' }, 'value: an array without one item schema'],
    [
      'a map with free keys',
      { type: 'object', additionalProperties: { type: 'string' } },
      'value: an object with free keys',
    ],
    ['no type', { description: 'Anything' }, 'value: no supported type'],
  ])('refuses a required argument with %s', (_label, value, reason) => {
    expect(
      nativeSchemaOf(tool({ type: 'object', properties: { value }, required: ['value'] }))
    ).toEqual({ ok: false, reason });
  });

  it('leaves out an optional argument it cannot express and keeps the tool', () => {
    expect(
      nativeSchemaOf(
        tool({
          type: 'object',
          properties: {
            query: { type: 'string' },
            filter: { anyOf: [{ type: 'string' }, { type: 'number' }] },
          },
          required: ['query'],
        })
      )
    ).toEqual({
      ok: true,
      omitted: [{ argument: 'filter', reason: 'anyOf' }],
      schema: {
        type: 'object',
        properties: [{ name: 'query', optional: false, schema: { type: 'string' } }],
      },
    });
  });

  it('answers the tools it can express and everything it left out, and keeps logging', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { tools, omitted } = nativeTools([
      { ...tool({ type: 'object', properties: {} }), name: 'clock' },
      {
        ...tool({
          type: 'object',
          properties: { value: { $ref: '#/x' }, note: { allOf: [] } },
          required: ['value'],
        }),
        name: 'broken',
      },
      {
        ...tool({ type: 'object', properties: { note: { allOf: [] } } }),
        name: 'partial',
      },
    ]);
    expect(tools.map(one => one.name)).toEqual(['clock', 'partial']);
    expect(JSON.parse(tools[0]?.parameters ?? '')).toEqual({ type: 'object', properties: [] });
    // The answer is the record a screen names the omitted tools from.
    expect(omitted).toEqual([
      { kind: 'tool', tool: 'broken', reason: 'value: $ref' },
      { kind: 'argument', tool: 'partial', argument: 'note', reason: 'allOf' },
    ]);
    expect(warn.mock.calls).toEqual([
      ['[native-model] tool left out: broken: value: $ref'],
      ['[native-model] optional argument left out: partial.note: allOf'],
    ]);
    warn.mockRestore();
  });

  it('names a nested omitted argument by its path, without logging, for a screen', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const omitted = omittedTools([
      tool({
        type: 'object',
        properties: {
          where: { type: 'object', properties: { region: { allOf: [] } } },
          filter: { anyOf: [{ type: 'string' }, { type: 'number' }] },
        },
      }),
    ]);
    expect(omitted).toEqual([
      { kind: 'argument', tool: 'tool', argument: 'where.region', reason: 'allOf' },
      { kind: 'argument', tool: 'tool', argument: 'filter', reason: 'anyOf' },
    ]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('drops settings_set and keeps settings_list, for the real settings tool schemas', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const service = {
      settings: [],
      read: () => {
        throw new Error('no read in this test');
      },
      write: () => {
        throw new Error('no write in this test');
      },
    };
    const { tools, omitted } = nativeTools(
      settingsTools(service as never).map(one => one.definition)
    );
    expect(tools.map(one => one.name)).toEqual(['settings_list']);
    expect(omitted).toEqual([{ kind: 'tool', tool: 'settings_set', reason: 'value: a type list' }]);
    warn.mockRestore();
  });
});
