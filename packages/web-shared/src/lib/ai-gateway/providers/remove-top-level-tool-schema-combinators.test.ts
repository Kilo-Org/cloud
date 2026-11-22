import { describe, expect, it } from '@jest/globals';

import {
  CLIENT_SCHEMA_MAX_DEPTH,
  CLIENT_SCHEMA_NODE_BUDGET,
} from '@kilocode/web-shared/lib/ai-gateway/providers/client-schema-budget';
import {
  removeTopLevelSchemaCombinators,
  removeTopLevelToolSchemaCombinators,
} from '@kilocode/web-shared/lib/ai-gateway/providers/remove-top-level-tool-schema-combinators';
import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';

type ObjectSchema = Record<string, unknown> & { type: 'object' };

function overDeepSchema(): ObjectSchema {
  const root: ObjectSchema = { type: 'object', anyOf: [{ required: ['a'] }] };
  let node = root;
  for (let level = 0; level <= CLIENT_SCHEMA_MAX_DEPTH + 5; level++) {
    const child: ObjectSchema = { type: 'object' };
    node.properties = { child };
    node = child;
  }
  return root;
}

function overWideSchema(): ObjectSchema {
  return {
    type: 'object',
    required: ['a'],
    anyOf: Array.from({ length: CLIENT_SCHEMA_NODE_BUDGET + 1 }, () => true),
  };
}

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

  it('leaves an anyOf root deeper than the depth budget unchanged', () => {
    const schema = overDeepSchema();
    const expected = structuredClone(schema);

    const constraints = removeTopLevelSchemaCombinators(schema);

    expect(constraints).toBeUndefined();
    expect(schema).toEqual(expected);
    expect(schema.anyOf).toBeDefined();
  });

  it('leaves an anyOf root wider than the node budget unchanged', () => {
    const schema = overWideSchema();
    const expected = structuredClone(schema);

    const constraints = removeTopLevelSchemaCombinators(schema);

    expect(constraints).toBeUndefined();
    expect(schema).toEqual(expected);
    expect(schema.anyOf).toBeDefined();
  });

  it('keeps only the required names every anyOf branch lists, in first-branch order', () => {
    const sharedNames = Array.from({ length: 2_000 }, (_, index) => `shared_${index}`);
    const firstNames = [
      ...sharedNames,
      ...Array.from({ length: 17_999 }, (_, index) => `only_first_${index}`),
      'shared_1',
    ];
    const secondNames = [
      ...sharedNames,
      ...Array.from({ length: 18_000 }, (_, index) => `only_second_${index}`),
    ];
    const anyOf = [{ required: firstNames }, { required: secondNames }];
    const schema: Record<string, unknown> = { type: 'object', anyOf };

    const constraints = removeTopLevelSchemaCombinators(schema);

    // A shared name the first branch repeats still appears once: addRequired dedupes.
    expect(schema.required).toEqual(sharedNames);
    expect(constraints).toBe(
      `The input must also match at least one of these JSON schemas: ${JSON.stringify(anyOf)}`
    );
  });
});

describe('removeTopLevelToolSchemaCombinators', () => {
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
  });

  it('appends no constraint text for a tool schema over the depth budget', () => {
    const request: GatewayRequest = {
      kind: 'messages',
      body: {
        model: 'anthropic/claude-opus-5.5',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'hello' }],
        tools: [{ name: 'f', description: 'Does f.', input_schema: overDeepSchema() }],
      },
    };

    removeTopLevelToolSchemaCombinators(request);

    expect(request.body.tools?.[0]).toStrictEqual({
      name: 'f',
      description: 'Does f.',
      input_schema: overDeepSchema(),
    });
  });
});
