import { type JsonSchema } from '@kilocode/harness-sdk';
import { describe, expect, it, vi } from 'vitest';

import { nativeSchemaOf, nativeTools } from './native-tool-schema';

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
    ['a real union', { anyOf: [{ type: 'string' }, { type: 'number' }] }, 'tool.value: anyOf'],
    ['a type list', { type: ['string', 'number'] }, 'tool.value: a type list'],
    ['a reference', { $ref: '#/$defs/value' }, 'tool.value: $ref'],
    ['an intersection', { allOf: [{ type: 'string' }] }, 'tool.value: allOf'],
    ['a constant', { type: 'string', const: 'x' }, 'tool.value: const'],
    [
      'a number enum',
      { type: 'integer', enum: [1, 2] },
      'tool.value: an enum that is not a list of strings',
    ],
    ['an empty enum', { enum: [] }, 'tool.value: an enum that is not a list of strings'],
    [
      'a tuple',
      { type: 'array', items: [{ type: 'string' }] },
      'tool.value: an array without one item schema',
    ],
    ['an array without items', { type: 'array' }, 'tool.value: an array without one item schema'],
    [
      'a map with free keys',
      { type: 'object', additionalProperties: { type: 'string' } },
      'tool.value: an object with free keys',
    ],
    ['no type', { description: 'Anything' }, 'tool.value: no supported type'],
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
      omitted: ['tool.filter: anyOf'],
      schema: {
        type: 'object',
        properties: [{ name: 'query', optional: false, schema: { type: 'string' } }],
      },
    });
  });

  it('logs and leaves out a tool it cannot express, and keeps the others', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const kept = nativeTools([
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
    expect(kept.map(one => one.name)).toEqual(['clock', 'partial']);
    expect(JSON.parse(kept[0]?.parameters ?? '')).toEqual({ type: 'object', properties: [] });
    expect(warn.mock.calls).toEqual([
      ['[native-model] tool left out: broken.value: $ref'],
      ['[native-model] optional argument left out: partial.note: allOf'],
    ]);
    warn.mockRestore();
  });
});
