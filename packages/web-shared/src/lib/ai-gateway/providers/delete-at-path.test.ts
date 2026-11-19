import { describe, expect, it } from '@jest/globals';
import { deleteAtPath } from './delete-at-path';

describe('deleteAtPath', () => {
  it('deletes a top-level key', () => {
    const body = { usage: { include: true }, model: 'm' };
    deleteAtPath(body, 'usage');
    expect(body).toEqual({ model: 'm' });
  });

  it('deletes a nested key', () => {
    const body = { a: { b: { c: 1, d: 2 } } };
    deleteAtPath(body, 'a.b.c');
    expect(body).toEqual({ a: { b: { d: 2 } } });
  });

  it('deletes through * over arrays', () => {
    const body = {
      tools: [
        { type: 'function', function: { name: 'a', strict: true } },
        { type: 'function', function: { name: 'b' } },
      ],
    };
    deleteAtPath(body, 'tools.*.function.strict');
    expect(body.tools).toEqual([
      { type: 'function', function: { name: 'a' } },
      { type: 'function', function: { name: 'b' } },
    ]);
  });

  it('deletes through * over objects', () => {
    const body = { schema: { x: { strict: true, type: 'a' }, y: { type: 'b' } } };
    deleteAtPath(body, 'schema.*.strict');
    expect(body).toEqual({ schema: { x: { type: 'a' }, y: { type: 'b' } } });
  });

  it('deletes through nested * segments, skipping string content', () => {
    const body = {
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'a', cache_control: { type: 'e' } }] },
        { role: 'assistant', content: 'plain' },
        {
          role: 'user',
          content: [
            { type: 'image_url', cache_control: { type: 'e' } },
            { type: 'text', text: 'b' },
          ],
        },
        { role: 'assistant', content: null },
      ],
    };
    deleteAtPath(body, 'messages.*.content.*.cache_control');
    expect(body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'a' }] },
      { role: 'assistant', content: 'plain' },
      { role: 'user', content: [{ type: 'image_url' }, { type: 'text', text: 'b' }] },
      { role: 'assistant', content: null },
    ]);
  });

  it('deletes from every element of an array when * is the parent segment', () => {
    const body = { messages: [{ cache_control: 1, role: 'user' }, { role: 'tool' }] };
    deleteAtPath(body, 'messages.*.cache_control');
    expect(body.messages).toEqual([{ role: 'user' }, { role: 'tool' }]);
  });

  it('does not fan out over an array for a plain segment', () => {
    const body = { messages: [{ cache_control: 1 }] };
    deleteAtPath(body, 'messages.cache_control');
    expect(body).toEqual({ messages: [{ cache_control: 1 }] });
  });

  it('does not treat an array index as a plain segment', () => {
    const body = { messages: [{ a: 1 }, { a: 2 }] };
    deleteAtPath(body, 'messages.0.a');
    deleteAtPath(body, 'messages.0');
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]).toEqual({ a: 1 });
  });

  it.each([
    ['missing key', { a: 1 }, 'b.c.d'],
    ['null intermediate', { a: null }, 'a.b'],
    ['string intermediate', { a: 'text' }, 'a.b'],
    ['number intermediate', { a: 5 }, 'a.length'],
    ['missing final key', { a: { b: 1 } }, 'a.c'],
  ])('ignores a %s', (_name, body, path) => {
    const copy = JSON.parse(JSON.stringify(body));
    expect(() => deleteAtPath(body, path)).not.toThrow();
    expect(body).toEqual(copy);
  });

  it('ignores a non-object root', () => {
    expect(() => deleteAtPath(null, 'a')).not.toThrow();
    expect(() => deleteAtPath('text', 'length')).not.toThrow();
  });

  it('only deletes own properties', () => {
    const inherited = Object.create({ shared: true });
    const body = { child: inherited };
    deleteAtPath(body, 'child.shared');
    expect(Object.getPrototypeOf(body.child)).toHaveProperty('shared', true);
    deleteAtPath(body, 'toString');
    expect(typeof body.toString).toBe('function');
  });

  it.each(['__proto__.polluted', 'a.constructor.prototype.polluted', 'constructor', 'prototype.x'])(
    'refuses blocked path %s',
    path => {
      const body = JSON.parse('{"__proto__": {"polluted": 1}, "a": {}}');
      deleteAtPath(body, path);
      expect(Object.getOwnPropertyNames(body)).toContain('__proto__');
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted')).toBe(false);
    }
  );

  it('refuses malformed paths', () => {
    const body = { a: { b: 1 }, '': 1 };
    deleteAtPath(body, '');
    deleteAtPath(body, 'a..b');
    deleteAtPath(body, 'a.*');
    expect(body).toEqual({ a: { b: 1 }, '': 1 });
  });
});
