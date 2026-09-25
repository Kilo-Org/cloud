import { type TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';

import { formatProfileCountItems, formatProfileCountItemsShort } from './profile-count-labels';

const t = i18n.t as TFunction;

describe('formatProfileCountItems', () => {
  it('localizes each count with its unit word, in order', () => {
    expect(
      formatProfileCountItems(t, [
        { kind: 'vars', count: 3 },
        { kind: 'mcp', count: 1 },
      ])
    ).toEqual(['3 vars', '1 MCP']);
    expect(formatProfileCountItems(t, [{ kind: 'commands', count: 1 }])).toEqual(['1 cmds']);
  });

  it('resolves nothing for an empty list', () => {
    expect(formatProfileCountItems(t, [])).toEqual([]);
  });
});

describe('formatProfileCountItemsShort', () => {
  it('localizes each count with its compact suffix, in order', () => {
    expect(
      formatProfileCountItemsShort(t, [
        { kind: 'vars', count: 3 },
        { kind: 'commands', count: 2 },
        { kind: 'skills', count: 1 },
      ])
    ).toEqual(['3v', '2c', '1s']);
  });

  it('falls back to the full unit word where no compact form exists', () => {
    expect(formatProfileCountItemsShort(t, [{ kind: 'mcp', count: 2 }])).toEqual(['2 MCP']);
  });
});
