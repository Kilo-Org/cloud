import { expect, it } from 'vitest';
import { dataOf, frames } from './sse.js';

it('keeps an unfinished event as the rest', () => {
  expect(frames('data: a\n\ndata: b')).toEqual({ events: ['data: a'], rest: 'data: b' });
});

it('joins the data lines of one event', () => {
  expect(dataOf('event: x\ndata: {"a":1}')).toBe('{"a":1}');
});

it('reads a data field split over two lines', () => {
  expect(dataOf('data: one\ndata: two')).toBe('one\ntwo');
});

it('skips the done marker', () => {
  expect(dataOf('data: [DONE]')).toBeUndefined();
});
