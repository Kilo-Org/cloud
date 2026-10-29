import { describe, expect, it } from '@jest/globals';
import {
  addMissingJsonSchemaEnumTypes,
  addMissingToolSchemaEnumTypes,
} from '@kilocode/web-shared/lib/ai-gateway/providers/add-missing-tool-schema-enum-types';
import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';

describe('addMissingJsonSchemaEnumTypes', () => {
  it('adds the type of a nested string enum', () => {
    const schema = {
      type: 'object',
      properties: {
        operations: {
          type: 'array',
          items: {
            type: 'object',
            properties: { op: { enum: ['set_title', 'delete_block'] } },
            required: ['op'],
          },
        },
      },
    };

    expect(addMissingJsonSchemaEnumTypes(schema)).toEqual({ typedEnums: 1, untypedEnums: 0 });
    expect(schema.properties.operations.items.properties.op).toEqual({
      type: 'string',
      enum: ['set_title', 'delete_block'],
    });
  });

  it.each([
    [[1, 2], 'integer'],
    [[1, 2.5], 'number'],
    [[true, false], 'boolean'],
    [
      ['a', null],
      ['string', 'null'],
    ],
  ])('infers the type of enum %p as %p', (values, type) => {
    const schema = { type: 'object', properties: { value: { enum: values } } };

    addMissingJsonSchemaEnumTypes(schema);

    expect(schema.properties.value).toEqual({ type, enum: values });
  });

  it.each([[[]], [['a', 1]], [[null]], [[{ a: 1 }]], [[['a']]]])(
    'leaves enum %p without a supported type alone',
    values => {
      const schema = { type: 'object', properties: { value: { enum: values } } };
      const expected = structuredClone(schema);

      expect(addMissingJsonSchemaEnumTypes(schema)).toEqual({ typedEnums: 0, untypedEnums: 1 });
      expect(schema).toEqual(expected);
    }
  );

  it('keeps an existing type', () => {
    const schema = { type: 'object', properties: { value: { type: 'string', enum: [1] } } };
    const expected = structuredClone(schema);

    expect(addMissingJsonSchemaEnumTypes(schema)).toEqual({ typedEnums: 0, untypedEnums: 0 });

    expect(schema).toEqual(expected);
  });

  it('updates enums in combinators and definitions', () => {
    const schema = {
      anyOf: [{ enum: ['a'] }],
      $defs: { mode: { enum: ['b'] } },
    };

    expect(addMissingJsonSchemaEnumTypes(schema)).toEqual({ typedEnums: 2, untypedEnums: 0 });

    expect(schema).toEqual({
      anyOf: [{ type: 'string', enum: ['a'] }],
      $defs: { mode: { type: 'string', enum: ['b'] } },
    });
  });

  it('ignores enums inside instance data and property maps', () => {
    const schema = {
      type: 'object',
      default: { enum: ['a'] },
      properties: { enum: { type: 'array', items: { type: 'string' } } },
    };
    const expected = structuredClone(schema);

    addMissingJsonSchemaEnumTypes(schema);

    expect(schema).toEqual(expected);
  });

  it.each([null, 'string', 42, []])('ignores non-object schema %p', schema => {
    expect(() => addMissingJsonSchemaEnumTypes(schema)).not.toThrow();
  });
});

describe('addMissingToolSchemaEnumTypes', () => {
  const untypedEnumSchema = () => ({
    type: 'object' as const,
    properties: { action: { enum: ['add', 'delete'] } },
  });
  const typedEnumSchema = {
    type: 'object',
    properties: { action: { type: 'string', enum: ['add', 'delete'] } },
  };

  it('updates chat completions function tools', () => {
    const request: GatewayRequest = {
      kind: 'chat_completions',
      body: {
        model: 'moonshotai/kimi-k3.1-pro',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [{ type: 'function', function: { name: 'f', parameters: untypedEnumSchema() } }],
      },
    };

    addMissingToolSchemaEnumTypes(request);

    const tool = request.body.tools?.[0];
    expect(tool?.type === 'function' && tool.function.parameters).toEqual(typedEnumSchema);
  });

  it('updates Responses function tools', () => {
    const request: GatewayRequest = {
      kind: 'responses',
      body: {
        model: 'moonshotai/kimi-k3.1-pro',
        input: 'hello',
        tools: [{ type: 'function', name: 'f', strict: false, parameters: untypedEnumSchema() }],
      },
    };

    addMissingToolSchemaEnumTypes(request);

    const tool = request.body.tools?.[0];
    expect(tool?.type === 'function' && tool.parameters).toEqual(typedEnumSchema);
  });

  it('updates Messages tools', () => {
    const request: GatewayRequest = {
      kind: 'messages',
      body: {
        model: 'moonshotai/kimi-k3.1-pro',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'hello' }],
        tools: [{ name: 'f', input_schema: untypedEnumSchema() }],
      },
    };

    addMissingToolSchemaEnumTypes(request);

    const tool = request.body.tools?.[0];
    expect(tool && 'input_schema' in tool && tool.input_schema).toEqual(typedEnumSchema);
  });
});
