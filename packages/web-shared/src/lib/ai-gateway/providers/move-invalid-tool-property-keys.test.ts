import { describe, expect, it } from '@jest/globals';
import {
  moveInvalidPropertyKeys,
  moveInvalidToolPropertyKeys,
} from '@kilocode/web-shared/lib/ai-gateway/providers/move-invalid-tool-property-keys';
import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';

const longKey = 'a'.repeat(65);

describe('moveInvalidPropertyKeys', () => {
  it('moves root properties with invalid names into exact-match patternProperties', () => {
    const schema = {
      type: 'object',
      properties: {
        ok_name: { type: 'string' },
        'dotted.name-1': { type: 'string' },
        'has space': { type: 'string', description: 'A spaced name.' },
        'a(b)+c$': { type: 'number' },
        [longKey]: { type: 'boolean' },
        '': { type: 'string' },
      },
      required: ['ok_name', 'has space'],
      additionalProperties: false,
    };

    const moved = moveInvalidPropertyKeys(schema);

    expect(moved).toEqual(['has space', 'a(b)+c$', longKey, '']);
    expect(schema).toEqual({
      type: 'object',
      properties: {
        ok_name: { type: 'string' },
        'dotted.name-1': { type: 'string' },
      },
      patternProperties: {
        '^has space$': { type: 'string', description: 'A spaced name.' },
        '^a\\(b\\)\\+c\\$$': { type: 'number' },
        [`^${longKey}$`]: { type: 'boolean' },
        '^$': { type: 'string' },
      },
      required: ['ok_name', 'has space'],
      additionalProperties: false,
    });
  });

  it('builds patterns that match only the original name', () => {
    const schema: Record<string, unknown> = {
      type: 'object',
      properties: { 'a.b|c[d]{2}*?^\\': { type: 'string' } },
    };

    moveInvalidPropertyKeys(schema);

    const patterns = Object.keys(schema.patternProperties as Record<string, unknown>);
    expect(patterns).toHaveLength(1);
    const regex = new RegExp(patterns[0] ?? '', 'u');
    expect(regex.test('a.b|c[d]{2}*?^\\')).toBe(true);
    expect(regex.test('aXb|c[d]{2}*?^\\')).toBe(false);
    expect(regex.test('c')).toBe(false);
  });

  it('keeps existing patternProperties and leaves a name whose pattern is taken', () => {
    const schema = {
      type: 'object',
      properties: { 'a b': { type: 'string' }, 'c d': { type: 'number' } },
      patternProperties: { '^x-': { type: 'string' }, '^c d$': { type: 'boolean' } },
    };

    expect(moveInvalidPropertyKeys(schema)).toEqual(['a b']);
    expect(schema).toEqual({
      type: 'object',
      properties: { 'c d': { type: 'number' } },
      patternProperties: {
        '^x-': { type: 'string' },
        '^c d$': { type: 'boolean' },
        '^a b$': { type: 'string' },
      },
    });
  });

  it('leaves nested properties and valid schemas untouched', () => {
    const schema = {
      type: 'object',
      properties: {
        nested: { type: 'object', properties: { 'a b': { type: 'string' } } },
      },
    };
    const expected = structuredClone(schema);

    expect(moveInvalidPropertyKeys(schema)).toEqual([]);
    expect(schema).toEqual(expected);
    expect(moveInvalidPropertyKeys(undefined)).toEqual([]);
    expect(moveInvalidPropertyKeys({ type: 'object' })).toEqual([]);
  });
});

describe('moveInvalidToolPropertyKeys', () => {
  const invalidSchema = () => ({
    type: 'object' as const,
    properties: { 'a b': { type: 'string' } },
    required: ['a b'],
  });
  const expectedSchema = {
    type: 'object',
    properties: {},
    patternProperties: { '^a b$': { type: 'string' } },
    required: ['a b'],
  };

  it('updates chat completions function tools and drops strict', () => {
    const request: GatewayRequest = {
      kind: 'chat_completions',
      body: {
        model: 'anthropic/claude-opus-5.5',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [
          {
            type: 'function',
            function: { name: 'f', strict: true, parameters: invalidSchema() },
          },
          {
            type: 'function',
            function: { name: 'g', strict: true, parameters: { type: 'object' } },
          },
        ],
      },
    };

    moveInvalidToolPropertyKeys(request);

    expect(request.body.tools).toEqual([
      { type: 'function', function: { name: 'f', parameters: expectedSchema } },
      { type: 'function', function: { name: 'g', strict: true, parameters: { type: 'object' } } },
    ]);
  });

  it('updates Responses function tools and disables strict', () => {
    const request: GatewayRequest = {
      kind: 'responses',
      body: {
        model: 'anthropic/claude-opus-5.5',
        input: 'hello',
        tools: [{ type: 'function', name: 'f', strict: true, parameters: invalidSchema() }],
      },
    };

    moveInvalidToolPropertyKeys(request);

    expect(request.body.tools).toEqual([
      { type: 'function', name: 'f', strict: false, parameters: expectedSchema },
    ]);
  });

  it('updates Messages custom tools and drops strict', () => {
    const request: GatewayRequest = {
      kind: 'messages',
      body: {
        model: 'anthropic/claude-opus-5.5',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hello' }],
        tools: [{ name: 'f', strict: true, input_schema: invalidSchema() }],
      },
    };

    moveInvalidToolPropertyKeys(request);

    expect(request.body.tools).toEqual([{ name: 'f', input_schema: expectedSchema }]);
  });
});
