import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../src/relay/canonical';

describe('canonicalJson', () => {
  it('sorts object keys at every depth', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: true, y: null }], c: 'x' } })).toBe(
      '{"a":{"c":"x","d":[2,{"y":null,"z":true}]},"b":1}'
    );
  });

  it('drops object members whose value is undefined', () => {
    expect(canonicalJson({ b: undefined, a: 1 })).toBe('{"a":1}');
  });

  it('rejects values JSON could not represent', () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(() => canonicalJson(() => 1)).toThrow(TypeError);
  });
});
