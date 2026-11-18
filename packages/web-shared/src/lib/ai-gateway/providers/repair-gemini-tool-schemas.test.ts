import { describe, expect, it } from '@jest/globals';
import {
  repairGeminiJsonSchema,
  repairGeminiToolSchemas,
} from '@kilocode/web-shared/lib/ai-gateway/providers/repair-gemini-tool-schemas';
import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';

function repaired(property: unknown) {
  const schema = { type: 'object', properties: { value: property } };
  repairGeminiJsonSchema(schema);
  return schema.properties.value;
}

// Keys beside an anyOf other than the ones Gemini allows, anywhere in the schema.
function offenders(node: unknown, path: string[] = []): string[] {
  if (node === null || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap((item, i) => offenders(item, [...path, String(i)]));
  const own =
    'anyOf' in node
      ? Object.keys(node).filter(key => !['anyOf', 'nullable', 'description'].includes(key))
      : [];
  return [
    ...own.map(key => [...path, key].join('.')),
    ...Object.entries(node).flatMap(([key, value]) => offenders(value, [...path, key])),
  ];
}

describe('repairGeminiJsonSchema', () => {
  describe('Kilo CLI type array output', () => {
    it('repairs a nullable string enum', () => {
      expect(
        repaired({
          anyOf: [{ type: 'string' }],
          nullable: true,
          enum: ['left', 'center', 'right', 'null'],
          description: 'Alignment; null clears it.',
        })
      ).toEqual({
        anyOf: [{ type: 'string', enum: ['left', 'center', 'right'] }, { type: 'null' }],
        description: 'Alignment; null clears it.',
      });
    });

    it('turns a nullable integer enum the CLI stringified into a string enum', () => {
      expect(
        repaired({ anyOf: [{ type: 'integer' }], nullable: true, enum: ['1', '2', '3', 'null'] })
      ).toEqual({ anyOf: [{ type: 'string', enum: ['1', '2', '3'] }, { type: 'null' }] });
    });

    it('merges a mixed enum the CLI stringified into one string branch', () => {
      expect(
        repaired({
          anyOf: [{ type: 'string' }, { type: 'number' }],
          nullable: true,
          enum: ['auto', '0', '1', 'null'],
          pattern: '^[a-z]+$',
          description: 'mixed value',
        })
      ).toEqual({
        anyOf: [
          { type: 'string', enum: ['auto', '0', '1'], pattern: '^[a-z]+$' },
          { type: 'null' },
        ],
        description: 'mixed value',
      });
    });

    it('moves type-specific keywords into the matching branches', () => {
      expect(
        repaired({
          anyOf: [{ type: 'string' }, { type: 'integer' }],
          format: 'date-time',
          pattern: '^r[0-9]+$',
          minLength: 2,
          minimum: 1,
          title: 'Revision',
        })
      ).toEqual({
        anyOf: [
          {
            type: 'string',
            format: 'date-time',
            pattern: '^r[0-9]+$',
            minLength: 2,
            title: 'Revision',
          },
          { type: 'integer', format: 'date-time', minimum: 1, title: 'Revision' },
        ],
      });
    });

    it('moves object and array keywords into their branches', () => {
      expect(
        repaired({
          anyOf: [{ type: 'object' }, { type: 'array' }],
          nullable: true,
          properties: { id: { type: 'string' } },
          required: ['id'],
          items: { type: 'string' },
        })
      ).toEqual({
        anyOf: [
          { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
          { type: 'array', items: { type: 'string' } },
          { type: 'null' },
        ],
      });
    });
  });

  it('keeps only a null branch when null was the only enum value', () => {
    expect(repaired({ anyOf: [{ type: 'string' }], nullable: true, enum: ['null'] })).toEqual({
      anyOf: [{ type: 'null' }],
    });
  });

  it('drops branches a const cannot match', () => {
    expect(repaired({ anyOf: [{ type: 'string' }, { type: 'integer' }], const: 'x' })).toEqual({
      anyOf: [{ type: 'string', const: 'x' }],
    });
  });

  it('repairs a nested anyOf branch that receives keys', () => {
    expect(
      repaired({
        anyOf: [{ anyOf: [{ type: 'string' }, { type: 'number' }] }, { type: 'null' }],
        title: 'T',
      })
    ).toEqual({
      anyOf: [
        {
          anyOf: [
            { type: 'string', title: 'T' },
            { type: 'number', title: 'T' },
          ],
        },
        { type: 'null', title: 'T' },
      ],
    });
  });

  it.each([
    [{ anyOf: [{ type: 'string' }], type: 'object' }],
    [{ anyOf: [{ required: ['b'] }], type: 'object', required: ['a'] }],
    [{ anyOf: [{ type: 'string' }, { type: 'integer' }], const: true }],
    [{ anyOf: [{ type: 'boolean' }], nullable: true, enum: ['true', 'false', 'null'] }],
  ])('leaves %p alone when merging would change what it accepts', property => {
    const expected = structuredClone(property);

    expect(repaired(property)).toEqual(expected);
  });

  it('leaves the root schema alone', () => {
    const schema = {
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'string' } },
      anyOf: [{ required: ['a'] }, { required: ['b'] }],
    };
    const expected = structuredClone(schema);

    expect(repairGeminiJsonSchema(schema)).toBe(0);
    expect(schema).toEqual(expected);
  });

  it('keeps the string "null" in an enum that is not nullable', () => {
    expect(repaired({ anyOf: [{ type: 'string' }], enum: ['a', 'null'] })).toEqual({
      anyOf: [{ type: 'string', enum: ['a', 'null'] }],
    });
  });

  it('copies keys into untyped branches and a default only into branches of its type', () => {
    expect(
      repaired({
        anyOf: [{ $ref: '#/$defs/a' }, { type: 'string' }, { type: 'integer' }, true],
        default: 'x',
        title: 'T',
      })
    ).toEqual({
      anyOf: [
        { $ref: '#/$defs/a', default: 'x', title: 'T' },
        { type: 'string', default: 'x', title: 'T' },
        { type: 'integer', title: 'T' },
        { default: 'x', title: 'T' },
      ],
    });
  });

  it('lowers a type array whose enum spans several types', () => {
    expect(
      repaired({
        type: ['string', 'number', 'null'],
        enum: ['auto', 0, 1, null],
        pattern: '^[a-z]+$',
        minimum: 0,
        description: 'mixed value',
      })
    ).toEqual({
      anyOf: [
        { type: 'string', enum: ['auto'], pattern: '^[a-z]+$' },
        { type: 'number', enum: [0, 1], minimum: 0 },
        { type: 'null' },
      ],
      description: 'mixed value',
    });
  });

  it('adds a null branch only when null is an enum value', () => {
    expect(repaired({ type: ['string', 'integer', 'null'], enum: ['a', 1] })).toEqual({
      anyOf: [
        { type: 'string', enum: ['a'] },
        { type: 'integer', enum: [1] },
      ],
    });
  });

  it.each([
    [{ type: ['string', 'null'], enum: ['left', 'center', null] }],
    [{ type: ['integer', 'number'], enum: [1, 2] }],
    [{ type: ['string', 'number'], enum: ['a', 'b'] }],
    [{ type: ['string', 'integer'], pattern: '^r[0-9]+$', minimum: 1 }],
    [{ anyOf: [{ type: 'string' }, { type: 'null' }], nullable: true, description: 'd' }],
    [{ type: 'string', enum: ['a'] }],
  ])('leaves schema %p that Gemini accepts alone', property => {
    const expected = structuredClone(property);

    expect(repaired(property)).toEqual(expected);
  });

  it('repairs nested schemas and leaves no keys beside anyOf', () => {
    const schema = {
      type: 'object',
      properties: {
        operations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              attrs: {
                anyOf: [{ type: 'object' }],
                nullable: true,
                properties: {
                  align: { anyOf: [{ type: 'string' }], nullable: true, enum: ['left', 'null'] },
                },
              },
            },
          },
        },
      },
      $defs: { level: { anyOf: [{ type: 'integer' }], enum: ['1'] } },
    };

    expect(repairGeminiJsonSchema(schema)).toBe(3);
    expect(offenders(schema)).toEqual([]);
    expect(schema.properties.operations.items.properties.attrs).toEqual({
      anyOf: [
        {
          type: 'object',
          properties: {
            align: { anyOf: [{ type: 'string', enum: ['left'] }, { type: 'null' }] },
          },
        },
        { type: 'null' },
      ],
    });
  });

  it('ignores anyOf-shaped data', () => {
    const schema = {
      type: 'object',
      default: { anyOf: [], enum: ['a'] },
      properties: { anyOf: { type: 'string' } },
    };
    const expected = structuredClone(schema);

    expect(repairGeminiJsonSchema(schema)).toBe(0);
    expect(schema).toEqual(expected);
  });

  it.each([null, 'string', 42, []])('ignores non-object schema %p', schema => {
    expect(repairGeminiJsonSchema(schema)).toBe(0);
  });
});

describe('repairGeminiToolSchemas', () => {
  const brokenSchema = () => ({
    type: 'object' as const,
    properties: { align: { anyOf: [{ type: 'string' }], nullable: true, enum: ['left', 'null'] } },
  });
  const repairedSchema = {
    type: 'object',
    properties: { align: { anyOf: [{ type: 'string', enum: ['left'] }, { type: 'null' }] } },
  };

  it('repairs chat completions function tools', () => {
    const request: GatewayRequest = {
      kind: 'chat_completions',
      body: {
        model: 'google/gemini-3.7-flash',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [{ type: 'function', function: { name: 'f', parameters: brokenSchema() } }],
      },
    };

    repairGeminiToolSchemas(request);

    const tool = request.body.tools?.[0];
    expect(tool?.type === 'function' && tool.function.parameters).toEqual(repairedSchema);
  });

  it('repairs Responses function tools', () => {
    const request: GatewayRequest = {
      kind: 'responses',
      body: {
        model: 'google/gemini-3.7-flash',
        input: 'hello',
        tools: [{ type: 'function', name: 'f', strict: false, parameters: brokenSchema() }],
      },
    };

    repairGeminiToolSchemas(request);

    const tool = request.body.tools?.[0];
    expect(tool?.type === 'function' && tool.parameters).toEqual(repairedSchema);
  });

  it('repairs Messages tools', () => {
    const request: GatewayRequest = {
      kind: 'messages',
      body: {
        model: 'google/gemini-3.7-flash',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'hello' }],
        tools: [{ name: 'f', input_schema: brokenSchema() }],
      },
    };

    repairGeminiToolSchemas(request);

    const tool = request.body.tools?.[0];
    expect(tool && 'input_schema' in tool && tool.input_schema).toEqual(repairedSchema);
  });
});
