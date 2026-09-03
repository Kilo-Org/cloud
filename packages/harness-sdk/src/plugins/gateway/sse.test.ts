import { expect, it } from 'vitest';
import { sseReader } from './sse.js';

it('holds an unfinished event until the rest of it arrives', () => {
  const read = sseReader();
  expect(read('data: {"a":')).toEqual([]);
  expect(read('1}\n\n')).toEqual(['{"a":1}']);
});

it('joins a data field written over two lines', () => {
  expect(sseReader()('data: one\ndata: two\n\n')).toEqual(['one\ntwo']);
});

it('reads two events out of one chunk', () => {
  expect(sseReader()('data: a\n\ndata: b\n\n')).toEqual(['a', 'b']);
});

it('skips a comment and the done marker', () => {
  expect(sseReader()(': ping\n\ndata: [DONE]\n\n')).toEqual([]);
});
