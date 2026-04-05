import { generateMessageSignature, parseJsonStringsDeep } from './messageSignature';

describe('generateMessageSignature', () => {
  it('matches the example behavior (strings are parsed as JSON when possible)', () => {
    const input = {
      a: 'b',
      c: 213,
      d: '{ "e": 5 }',
    };

    expect(generateMessageSignature(input)).toEqual({
      a: 'string',
      c: 'number',
      d: { e: 'number' },
    });
  });

  it('parses JSON strings recursively (including nested JSON strings)', () => {
    const input = {
      arr: JSON.stringify([1, '2', { b: 'true' }, JSON.stringify({ c: null })]),
    };

    expect(generateMessageSignature(input)).toEqual({
      arr: ['number', 'number', { b: 'boolean' }, { c: 'null' }],
    });
  });

  it('treats invalid JSON strings as plain strings', () => {
    const input = {
      a: '{ bad json }',
      b: 'not-json',
    };

    expect(generateMessageSignature(input)).toEqual({
      a: 'string',
      b: 'string',
    });
  });

  it('is deterministic (object keys are emitted in sorted order)', () => {
    const input: Record<string, unknown> = {};
    input.b = 1;
    input.a = 2;

    const signature = generateMessageSignature(input);
    expect(JSON.stringify(signature)).toBe('{"a":"number","b":"number"}');
  });

  it('does not mutate the input', () => {
    const input = {
      a: '{"b": 1}',
      c: ['2'],
    };
    const before = JSON.stringify(input);

    void generateMessageSignature(input);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('throws on unsupported runtime types (non-JSON values)', () => {
    expect(() => generateMessageSignature(() => undefined)).toThrow(
      'Unsupported value for signature generation'
    );
  });
});

describe('parseJsonStringsDeep', () => {
  it('keeps parsing while a string remains valid JSON', () => {
    const value = JSON.stringify(JSON.stringify({ a: 1 }));
    const parsed = parseJsonStringsDeep(value);
    expect(parsed).toEqual({ a: 1 });
  });
});
