import { describe, expect, test } from '@jest/globals';
import { z } from 'zod';
import { deepStrict } from './deep-strict';

describe('deepStrict', () => {
  test('rejects unknown keys at the top level', () => {
    const schema = deepStrict(z.object({ a: z.string() }));
    expect(schema.safeParse({ a: 'x', extra: 1 }).success).toBe(false);
    expect(schema.safeParse({ a: 'x' }).success).toBe(true);
  });

  test('rejects unknown keys in nested objects', () => {
    const schema = deepStrict(
      z.object({
        outer: z.object({
          inner: z.string(),
        }),
      })
    );
    expect(schema.safeParse({ outer: { inner: 'x', typo: 1 } }).success).toBe(false);
    expect(schema.safeParse({ outer: { inner: 'x' } }).success).toBe(true);
  });

  test('rejects unknown keys inside optional objects', () => {
    const schema = deepStrict(
      z.object({
        settings: z.object({ flag: z.boolean() }).optional(),
      })
    );
    expect(schema.safeParse({ settings: { flag: true, typo: 1 } }).success).toBe(false);
    expect(schema.safeParse({ settings: { flag: true } }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(true);
  });

  test('rejects unknown keys inside nullable objects', () => {
    const schema = deepStrict(
      z.object({
        profile: z.object({ name: z.string() }).nullable(),
      })
    );
    expect(schema.safeParse({ profile: { name: 'a', typo: 1 } }).success).toBe(false);
    expect(schema.safeParse({ profile: null }).success).toBe(true);
  });

  test('rejects unknown keys inside array elements', () => {
    const schema = deepStrict(
      z.object({
        items: z.array(z.object({ id: z.string() })),
      })
    );
    expect(schema.safeParse({ items: [{ id: 'a' }, { id: 'b', typo: 1 }] }).success).toBe(false);
    expect(schema.safeParse({ items: [{ id: 'a' }, { id: 'b' }] }).success).toBe(true);
  });

  test('rejects unknown keys inside record values', () => {
    const schema = deepStrict(
      z.object({
        by_id: z.record(z.string(), z.object({ name: z.string() })),
      })
    );
    expect(schema.safeParse({ by_id: { x: { name: 'a', typo: 1 } } }).success).toBe(false);
    expect(schema.safeParse({ by_id: { x: { name: 'a' } } }).success).toBe(true);
  });

  test('rejects unknown keys inside union members', () => {
    const schema = deepStrict(
      z.union([
        z.object({ kind: z.literal('a'), foo: z.string() }),
        z.object({ kind: z.literal('b'), bar: z.number() }),
      ])
    );
    expect(schema.safeParse({ kind: 'a', foo: 'x', typo: 1 }).success).toBe(false);
    expect(schema.safeParse({ kind: 'a', foo: 'x' }).success).toBe(true);
    expect(schema.safeParse({ kind: 'b', bar: 1 }).success).toBe(true);
  });

  test('rejects deeply nested unknown keys', () => {
    const schema = deepStrict(
      z.object({
        a: z.object({
          b: z.object({
            c: z.object({
              d: z.string(),
            }),
          }),
        }),
      })
    );
    expect(schema.safeParse({ a: { b: { c: { d: 'x', typo: 1 } } } }).success).toBe(false);
    expect(schema.safeParse({ a: { b: { c: { d: 'x' } } } }).success).toBe(true);
  });

  test('preserves leaf validation', () => {
    const schema = deepStrict(z.object({ n: z.number() }));
    expect(schema.safeParse({ n: 'not-a-number' }).success).toBe(false);
    expect(schema.safeParse({ n: 5 }).success).toBe(true);
  });

  test('passes recognised leaves through unchanged', () => {
    const leaves = [
      z.string(),
      z.number(),
      z.boolean(),
      z.date(),
      z.literal('x'),
      z.enum(['a', 'b']),
      z.any(),
      z.unknown(),
      z.bigint(),
    ];
    for (const leaf of leaves) {
      expect(() => deepStrict(leaf)).not.toThrow();
    }
  });

  test('throws on unsupported wrappers so new Zod types surface loudly', () => {
    expect(() =>
      deepStrict(z.intersection(z.object({ a: z.string() }), z.object({ b: z.number() })))
    ).toThrow(/deepStrict: unsupported Zod type 'intersection'/);
    expect(() => deepStrict(z.tuple([z.string(), z.number()]))).toThrow(
      /deepStrict: unsupported Zod type 'tuple'/
    );
    expect(() => deepStrict(z.string().transform(s => s.length))).toThrow(
      /deepStrict: unsupported Zod type/
    );
  });
});
