import { describe, expect, it } from '@jest/globals';
import {
  removeRecursiveJsonSchemaRefs,
  removeRecursiveToolSchemaRefs,
} from '@kilocode/web-shared/lib/ai-gateway/providers/remove-recursive-tool-schema-refs';
import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';

describe('removeRecursiveJsonSchemaRefs', () => {
  it('replaces a recursive ref with the referenced type and keeps sibling keywords', () => {
    const schema = {
      type: 'object',
      properties: { filters: { $ref: '#/$defs/filters' } },
      $defs: {
        filters: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              filters: { $ref: '#/$defs/filters', description: 'Nested filters' },
            },
          },
        },
      },
    };

    removeRecursiveJsonSchemaRefs(schema);

    expect(schema).toEqual({
      type: 'object',
      properties: { filters: { $ref: '#/$defs/filters' } },
      $defs: {
        filters: {
          type: 'array',
          items: {
            type: 'object',
            properties: { filters: { type: 'array', description: 'Nested filters' } },
          },
        },
      },
    });
  });

  it('keeps non-recursive refs', () => {
    const schema = {
      type: 'object',
      properties: { a: { $ref: '#/$defs/leaf' }, b: { $ref: '#/$defs/leaf' } },
      $defs: { leaf: { type: 'string' } },
    };
    const expected = structuredClone(schema);

    removeRecursiveJsonSchemaRefs(schema);

    expect(schema).toEqual(expected);
  });

  it('removes a root self-reference', () => {
    const schema = {
      type: 'object',
      properties: { child: { $ref: '#' } },
    };

    removeRecursiveJsonSchemaRefs(schema);

    expect(schema).toEqual({ type: 'object', properties: { child: { type: 'object' } } });
  });

  it('breaks mutual recursion between definitions', () => {
    const schema = {
      $ref: '#/definitions/a',
      definitions: {
        a: { type: 'object', properties: { b: { $ref: '#/definitions/b' } } },
        b: { type: 'object', properties: { a: { $ref: '#/definitions/a' } } },
      },
    };

    removeRecursiveJsonSchemaRefs(schema);

    expect(schema.definitions).toEqual({
      a: { type: 'object', properties: { b: { $ref: '#/definitions/b' } } },
      b: { type: 'object', properties: { a: { type: 'object' } } },
    });
  });

  it('ignores refs inside instance data keywords', () => {
    const schema = {
      type: 'object',
      properties: { child: { default: { $ref: '#' }, enum: [{ $ref: '#' }] } },
    };
    const expected = structuredClone(schema);

    removeRecursiveJsonSchemaRefs(schema);

    expect(schema).toEqual(expected);
  });

  it('removes recursive refs from properties and definitions named like data keywords', () => {
    const schema = {
      type: 'object',
      properties: {
        default: { $ref: '#' },
        enum: { $ref: '#/$defs/const' },
      },
      patternProperties: { examples: { $ref: '#' } },
      $defs: { const: { type: 'array', items: { $ref: '#/$defs/const' } } },
    };

    removeRecursiveJsonSchemaRefs(schema);

    expect(schema).toEqual({
      type: 'object',
      properties: {
        default: { type: 'object' },
        enum: { $ref: '#/$defs/const' },
      },
      patternProperties: { examples: { type: 'object' } },
      $defs: { const: { type: 'array', items: { type: 'array' } } },
    });
  });

  it('ignores remote and unresolvable refs', () => {
    const schema = {
      type: 'object',
      properties: {
        remote: { $ref: 'https://example.com/schema.json' },
        missing: { $ref: '#/$defs/missing' },
        malformed: { $ref: '#/$defs/%E0%A4%A' },
      },
    };
    const expected = structuredClone(schema);

    removeRecursiveJsonSchemaRefs(schema);

    expect(schema).toEqual(expected);
  });

  it('resolves escaped JSON pointer segments', () => {
    const schema = {
      type: 'object',
      properties: { node: { $ref: '#/$defs/a~1b' } },
      $defs: { 'a/b': { type: 'array', items: { $ref: '#/$defs/a~1b' } } },
    };

    removeRecursiveJsonSchemaRefs(schema);

    expect(schema.$defs['a/b']).toEqual({ type: 'array', items: { type: 'array' } });
  });

  it.each([null, 'string', 42, []])('ignores non-object schema %p', schema => {
    expect(() => removeRecursiveJsonSchemaRefs(schema)).not.toThrow();
  });
});

describe('removeRecursiveToolSchemaRefs', () => {
  const recursiveSchema = () => ({
    type: 'object' as const,
    properties: { child: { $ref: '#' } },
  });

  it('updates chat completions function tools', () => {
    const request: GatewayRequest = {
      kind: 'chat_completions',
      body: {
        model: 'meta/muse-spark-1.3',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [{ type: 'function', function: { name: 'f', parameters: recursiveSchema() } }],
      },
    };

    removeRecursiveToolSchemaRefs(request);

    const tool = request.body.tools?.[0];
    expect(tool?.type === 'function' && tool.function.parameters).toEqual({
      type: 'object',
      properties: { child: { type: 'object' } },
    });
  });

  it('updates Responses function tools', () => {
    const request: GatewayRequest = {
      kind: 'responses',
      body: {
        model: 'meta/muse-spark-1.3',
        input: 'hello',
        tools: [{ type: 'function', name: 'f', strict: false, parameters: recursiveSchema() }],
      },
    };

    removeRecursiveToolSchemaRefs(request);

    const tool = request.body.tools?.[0];
    expect(tool?.type === 'function' && tool.parameters).toEqual({
      type: 'object',
      properties: { child: { type: 'object' } },
    });
  });

  it('updates Messages tools', () => {
    const request: GatewayRequest = {
      kind: 'messages',
      body: {
        model: 'meta/muse-spark-1.3',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'hello' }],
        tools: [{ name: 'f', input_schema: recursiveSchema() }],
      },
    };

    removeRecursiveToolSchemaRefs(request);

    const tool = request.body.tools?.[0];
    expect(tool && 'input_schema' in tool && tool.input_schema).toEqual({
      type: 'object',
      properties: { child: { type: 'object' } },
    });
  });
});
