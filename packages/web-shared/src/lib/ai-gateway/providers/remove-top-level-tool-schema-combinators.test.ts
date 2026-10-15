import { describe, expect, it } from '@jest/globals';
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
  it('removes a top-level oneOf and keeps the root properties', () => {
    const schema: Record<string, unknown> = nteractCreateCellSchema();
    const { oneOf: _oneOf, ...expected } = nteractCreateCellSchema();

    removeTopLevelSchemaCombinators(schema);

    expect(schema).toEqual(expected);
  });

  it('adds properties only declared by anyOf branches as optional properties', () => {
    const schema = {
      type: 'object',
      properties: { a: { type: 'string' } },
      additionalProperties: false,
      anyOf: [
        { required: ['b'], properties: { a: { type: 'null' }, b: { type: 'number' } } },
        { required: ['c'], properties: { c: { type: 'boolean' } } },
      ],
    };

    removeTopLevelSchemaCombinators(schema);

    expect(schema).toEqual({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'number' }, c: { type: 'boolean' } },
      additionalProperties: false,
    });
  });

  it('keeps required entries from allOf branches', () => {
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

  it('keeps nested combinators', () => {
    const schema = {
      type: 'object',
      properties: { a: { anyOf: [{ type: 'string' }, { type: 'number' }] } },
    };
    const expected = structuredClone(schema);

    removeTopLevelSchemaCombinators(schema);

    expect(schema).toEqual(expected);
  });

  it.each([null, 'string', 42, []])('ignores non-object schema %p', schema => {
    expect(() => removeTopLevelSchemaCombinators(schema)).not.toThrow();
  });
});

describe('removeTopLevelToolSchemaCombinators', () => {
  const combinatorSchema = () => ({
    type: 'object' as const,
    properties: { a: { type: 'string' } },
    oneOf: [{ required: ['a'] }],
  });
  const expectedSchema = { type: 'object', properties: { a: { type: 'string' } } };

  it('updates chat completions function tools', () => {
    const request: GatewayRequest = {
      kind: 'chat_completions',
      body: {
        model: 'anthropic/claude-opus-5.5',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [{ type: 'function', function: { name: 'f', parameters: combinatorSchema() } }],
      },
    };

    removeTopLevelToolSchemaCombinators(request);

    const tool = request.body.tools?.[0];
    expect(tool?.type === 'function' && tool.function.parameters).toEqual(expectedSchema);
  });

  it('updates Responses function tools', () => {
    const request: GatewayRequest = {
      kind: 'responses',
      body: {
        model: 'anthropic/claude-opus-5.5',
        input: 'hello',
        tools: [{ type: 'function', name: 'f', strict: false, parameters: combinatorSchema() }],
      },
    };

    removeTopLevelToolSchemaCombinators(request);

    const tool = request.body.tools?.[0];
    expect(tool?.type === 'function' && tool.parameters).toEqual(expectedSchema);
  });

  it('updates Messages tools', () => {
    const request: GatewayRequest = {
      kind: 'messages',
      body: {
        model: 'anthropic/claude-opus-5.5',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'hello' }],
        tools: [{ name: 'f', input_schema: combinatorSchema() }],
      },
    };

    removeTopLevelToolSchemaCombinators(request);

    const tool = request.body.tools?.[0];
    expect(tool && 'input_schema' in tool && tool.input_schema).toEqual(expectedSchema);
  });
});
