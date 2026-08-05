import { createElement } from 'react';
import { describe, expect, it } from 'vitest';

import { extractNodeText, linearRowLabel } from './markdown-a11y';

describe('extractNodeText', () => {
  it('returns strings verbatim', () => {
    expect(extractNodeText('hello')).toBe('hello');
    expect(extractNodeText('')).toBe('');
  });

  it('converts numbers to their string form', () => {
    expect(extractNodeText(42)).toBe('42');
    expect(extractNodeText(0)).toBe('0');
  });

  it('joins arrays with a single space', () => {
    expect(extractNodeText(['a', 'b', 'c'])).toBe('a b c');
    expect(extractNodeText(['a', 1, 'b'])).toBe('a 1 b');
  });

  it('recurses into nested Text elements', () => {
    const nested = createElement('Text', null, createElement('Text', null, 'deep'));
    expect(extractNodeText(nested)).toBe('deep');
  });

  it('recurse into an element without an accessibilityLabel', () => {
    const element = createElement('View', null, 'child text');
    expect(extractNodeText(element)).toBe('child text');
  });

  it('prefers an explicit accessibilityLabel over children', () => {
    const labeled = createElement('View', { accessibilityLabel: 'explicit' }, 'visible text');
    expect(extractNodeText(labeled)).toBe('explicit');
  });

  it('returns empty for null, undefined, and empty elements', () => {
    expect(extractNodeText(null)).toBe('');
    expect(extractNodeText(undefined)).toBe('');
    expect(extractNodeText(createElement('View'))).toBe('');
  });
});

describe('linearRowLabel', () => {
  it('pairs each non-empty cell with its header', () => {
    expect(linearRowLabel(['Name', 'Age'], ['John', '30'])).toBe('Name: John, Age: 30');
  });

  it('skips empty cells', () => {
    expect(linearRowLabel(['Name', 'Age'], ['John', ''])).toBe('Name: John');
  });

  it('keeps cells without a header as bare text', () => {
    expect(linearRowLabel(['Name'], ['John', 'extra'])).toBe('Name: John, extra');
  });

  it('handles fewer cells than headers', () => {
    expect(linearRowLabel(['Name', 'Age'], ['John'])).toBe('Name: John');
  });

  it('trims header and cell text', () => {
    expect(linearRowLabel([' Name '], [' John '])).toBe('Name: John');
  });

  it('returns empty when no cell has text', () => {
    expect(linearRowLabel(['Name'], [])).toBe('');
    expect(linearRowLabel(['Name'], [''])).toBe('');
  });

  it('composes extractNodeText outputs for a full row', () => {
    const header = ['Item', 'Qty'];
    const cells = [extractNodeText(createElement('Text', null, 'Apples')), extractNodeText(3)];
    expect(linearRowLabel(header, cells)).toBe('Item: Apples, Qty: 3');
  });
});
