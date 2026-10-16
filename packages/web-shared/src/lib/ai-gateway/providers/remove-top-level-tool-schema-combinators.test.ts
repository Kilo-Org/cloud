import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  removeTopLevelSchemaCombinators,
  removeTopLevelToolSchemaCombinators,
} from '@kilocode/web-shared/lib/ai-gateway/providers/remove-top-level-tool-schema-combinators';
import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';

const nteractCreateCellSchema = () => ({
  type: 'object',
  properties: {
    source: {
      description: 'Cell source code or markdown content.',
      type: ['string', 'null'],
      default: null,
    },
    after_cell_id: {
      description: 'Insert after this cell.',
      type: ['string', 'null'],
    },
    notebook_handle: {
      type: ['string', 'null'],
      minLength: 1,
      description: 'Compatibility attachment handle; use instead of notebook_id/domain.',
    },
    notebook_id: {
      type: ['string', 'null'],
      minLength: 1,
      description: 'ID of an already connected notebook.',
    },
    domain: {
      type: ['string', 'null'],
      minLength: 1,
      description: 'Configured hosted domain; only with notebook_id.',
    },
  },
  required: [],
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'CreateCellParams',
  additionalProperties: false,
  oneOf: [
    {
      required: ['notebook_handle'],
      properties: {
        notebook_handle: { type: 'string', minLength: 1 },
        notebook_id: { type: 'null' },
        domain: { type: 'null' },
      },
    },
    {
      required: ['notebook_id'],
      properties: {
        notebook_id: { type: 'string', minLength: 1 },
        notebook_handle: { type: 'null' },
      },
    },
  ],
  'x-nteract-notebook-target-version': 1,
});

describe('removeTopLevelSchemaCombinators', () => {
  it('removes a top-level oneOf, keeps the root properties and describes the constraint', () => {
    const schema: Record<string, unknown> = nteractCreateCellSchema();
    const { oneOf, ...expected } = nteractCreateCellSchema();

    const constraints = removeTopLevelSchemaCombinators(schema);

    expect(schema).toEqual(expected);
    expect(constraints).toBe(
      `The input must also match exactly one of these JSON schemas: ${JSON.stringify(oneOf)}`
    );
  });

  it('adds properties only declared by anyOf branches and requires what every branch requires', () => {
    const schema = {
      type: 'object',
      properties: { a: { type: 'string' } },
      additionalProperties: false,
      anyOf: [
        { required: ['b', 'd'], properties: { a: { type: 'null' }, b: { type: 'number' } } },
        { required: ['c', 'd'], properties: { c: { type: 'boolean' }, d: { type: 'string' } } },
      ],
    };

    removeTopLevelSchemaCombinators(schema);

    expect(schema).toEqual({
      type: 'object',
      properties: {
        a: { type: 'string' },
        b: { type: 'number' },
        c: { type: 'boolean' },
        d: { type: 'string' },
      },
      required: ['d'],
      additionalProperties: false,
    });
  });

  it('requires nothing extra when a oneOf branch has no required properties', () => {
    const schema = {
      type: 'object',
      properties: { a: { type: 'string' } },
      oneOf: [{ required: ['a'] }, { properties: { b: { type: 'string' } } }],
    };

    removeTopLevelSchemaCombinators(schema);

    expect(schema).toEqual({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'string' } },
    });
  });

  it('keeps required entries from every allOf branch', () => {
    const schema = {
      type: 'object',
      required: ['a'],
      allOf: [
        { required: ['a', 'b'], properties: { b: { type: 'string' } } },
        { required: ['c'], properties: { c: { type: 'string' } } },
      ],
    };

    removeTopLevelSchemaCombinators(schema);

    expect(schema).toEqual({
      type: 'object',
      required: ['a', 'b', 'c'],
      properties: { b: { type: 'string' }, c: { type: 'string' } },
    });
  });

  it('describes each removed combinator on its own line', () => {
    const schema = {
      type: 'object',
      allOf: [{ required: ['a'] }],
      anyOf: [{ required: ['b'] }, { required: ['c'] }],
    };

    const constraints = removeTopLevelSchemaCombinators(schema);

    expect(constraints).toBe(
      [
        'The input must also match all of these JSON schemas: [{"required":["a"]}]',
        'The input must also match at least one of these JSON schemas: [{"required":["b"]},{"required":["c"]}]',
      ].join('\n')
    );
  });

  it('sets the object type when the root only had combinators', () => {
    const schema = {
      oneOf: [
        { type: 'object', properties: { a: { type: 'string' } } },
        { type: 'object', properties: { b: { type: 'string' } } },
      ],
    };

    removeTopLevelSchemaCombinators(schema);

    expect(schema).toEqual({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'string' } },
    });
  });

  it('removes a malformed combinator without describing it', () => {
    const schema = { type: 'object', oneOf: { required: ['a'] } };

    const constraints = removeTopLevelSchemaCombinators(schema);

    expect(schema).toEqual({ type: 'object' });
    expect(constraints).toBeUndefined();
  });

  it('keeps nested combinators', () => {
    const schema = {
      type: 'object',
      properties: { a: { anyOf: [{ type: 'string' }, { type: 'number' }] } },
    };
    const expected = structuredClone(schema);

    const constraints = removeTopLevelSchemaCombinators(schema);

    expect(schema).toEqual(expected);
    expect(constraints).toBeUndefined();
  });

  it.each([null, 'string', 42, []])('ignores non-object schema %p', schema => {
    expect(removeTopLevelSchemaCombinators(schema)).toBeUndefined();
  });
});

describe('removeTopLevelToolSchemaCombinators', () => {
  let warn: jest.SpiedFunction<typeof console.warn>;

  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  const combinatorSchema = () => ({
    type: 'object' as const,
    properties: { a: { type: 'string' } },
    oneOf: [{ required: ['a'] }],
  });
  const expectedSchema = {
    type: 'object',
    properties: { a: { type: 'string' } },
    required: ['a'],
  };
  const constraints =
    'The input must also match exactly one of these JSON schemas: [{"required":["a"]}]';

  it('updates chat completions function tools and keeps strict', () => {
    const request: GatewayRequest = {
      kind: 'chat_completions',
      body: {
        model: 'anthropic/claude-opus-5.5',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'f',
              description: 'Does f.',
              strict: true,
              parameters: combinatorSchema(),
            },
          },
        ],
      },
    };

    removeTopLevelToolSchemaCombinators(request);

    const tool = request.body.tools?.[0];
    expect(tool?.type === 'function' && tool.function).toEqual({
      name: 'f',
      description: `Does f.\n\n${constraints}`,
      strict: true,
      parameters: expectedSchema,
    });
  });

  it('updates Responses function tools without a description', () => {
    const request: GatewayRequest = {
      kind: 'responses',
      body: {
        model: 'anthropic/claude-opus-5.5',
        input: 'hello',
        tools: [
          {
            type: 'function',
            name: 'f',
            description: null,
            strict: true,
            parameters: combinatorSchema(),
          },
        ],
      },
    };

    removeTopLevelToolSchemaCombinators(request);

    expect(request.body.tools?.[0]).toEqual({
      type: 'function',
      name: 'f',
      description: constraints,
      strict: true,
      parameters: expectedSchema,
    });
  });

  it('updates Messages tools and keeps strict', () => {
    const request: GatewayRequest = {
      kind: 'messages',
      body: {
        model: 'anthropic/claude-opus-5.5',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'hello' }],
        tools: [
          { name: 'f', description: 'Does f.', strict: true, input_schema: combinatorSchema() },
        ],
      },
    };

    removeTopLevelToolSchemaCombinators(request);

    expect(request.body.tools?.[0]).toEqual({
      name: 'f',
      description: `Does f.\n\n${constraints}`,
      strict: true,
      input_schema: expectedSchema,
    });
  });

  it('leaves tools without top-level combinators untouched', () => {
    const request: GatewayRequest = {
      kind: 'messages',
      body: {
        model: 'anthropic/claude-opus-5.5',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'hello' }],
        tools: [{ name: 'f', input_schema: { type: 'object', properties: {} } }],
      },
    };

    removeTopLevelToolSchemaCombinators(request);

    expect(request.body.tools?.[0]).toStrictEqual({
      name: 'f',
      input_schema: { type: 'object', properties: {} },
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('logs the changed tools once per request', () => {
    const request: GatewayRequest = {
      kind: 'messages',
      body: {
        model: 'anthropic/claude-opus-5.5',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'hello' }],
        tools: [
          { name: 'plain', input_schema: { type: 'object', properties: {} } },
          { name: 'strict_one_of', strict: true, input_schema: combinatorSchema() },
          {
            name: 'all_and_any_of',
            input_schema: {
              type: 'object',
              allOf: [{ required: ['a'] }],
              anyOf: [{ required: ['b'] }],
            },
          },
        ],
      },
    };

    removeTopLevelToolSchemaCombinators(request);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '[removeTopLevelToolSchemaCombinators] removed top-level tool schema combinators',
      {
        model: 'anthropic/claude-opus-5.5',
        requestKind: 'messages',
        tools: [
          { name: 'strict_one_of', combinators: ['oneOf'], strict: true },
          { name: 'all_and_any_of', combinators: ['allOf', 'anyOf'], strict: false },
        ],
      }
    );
  });
});
