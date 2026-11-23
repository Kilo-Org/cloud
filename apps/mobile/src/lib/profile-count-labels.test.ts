import { type TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';

import {
  draftProfileCountItems,
  formatProfileCountItems,
  type ProfileCountCounts,
  profileCountItems,
} from './profile-count-labels';

const t = i18n.t as TFunction;

function counts(overrides: Partial<ProfileCountCounts> = {}): ProfileCountCounts {
  return {
    varCount: 0,
    mcpServerCount: 0,
    skillCount: 0,
    kiloCommandCount: 0,
    commandCount: 0,
    agentCount: 0,
    ...overrides,
  };
}

describe('profileCountItems', () => {
  it('resolves every count in the canonical order', () => {
    expect(
      profileCountItems(
        counts({
          varCount: 2,
          mcpServerCount: 1,
          skillCount: 1,
          kiloCommandCount: 3,
          commandCount: 2,
          agentCount: 4,
        })
      )
    ).toEqual([
      { kind: 'vars', count: 2 },
      { kind: 'mcp', count: 1 },
      { kind: 'skills', count: 1 },
      { kind: 'commands', count: 3 },
      { kind: 'setupCommands', count: 2 },
      { kind: 'agents', count: 4 },
    ]);
  });

  it('labels the two command collections apart from their own fields', () => {
    expect(profileCountItems(counts({ kiloCommandCount: 1 }))).toEqual([
      { kind: 'commands', count: 1 },
    ]);
    expect(profileCountItems(counts({ commandCount: 1 }))).toEqual([
      { kind: 'setupCommands', count: 1 },
    ]);
  });

  it('omits zero counts, so an empty profile resolves no items', () => {
    expect(profileCountItems(counts())).toEqual([]);
    expect(profileCountItems(counts({ agentCount: 2 }))).toEqual([{ kind: 'agents', count: 2 }]);
  });
});

describe('formatProfileCountItems', () => {
  it('localizes each count with its unit word, in order', () => {
    expect(
      formatProfileCountItems(t, [
        { kind: 'vars', count: 3 },
        { kind: 'mcp', count: 1 },
      ])
    ).toEqual(['3 vars', '1 MCP']);
    expect(formatProfileCountItems(t, [{ kind: 'commands', count: 1 }])).toEqual(['1 cmd']);
    expect(formatProfileCountItems(t, [{ kind: 'commands', count: 2 }])).toEqual(['2 cmds']);
    expect(formatProfileCountItems(t, [{ kind: 'setupCommands', count: 2 }])).toEqual([
      '2 setup cmds',
    ]);
    expect(formatProfileCountItems(t, [{ kind: 'agents', count: 1 }])).toEqual(['1 agent']);
    expect(formatProfileCountItems(t, [{ kind: 'agents', count: 2 }])).toEqual(['2 agents']);
  });

  it('selects the singular form at count 1 in Swedish', async () => {
    await i18n.changeLanguage('sv');
    try {
      expect(i18n.t('profiles.counts.commands', { count: 1 })).toBe('1 kommando');
      expect(i18n.t('profiles.counts.commands', { count: 2 })).toBe('2 kommandon');
      expect(i18n.t('profiles.counts.vars', { count: 1 })).toBe('1 variabel');
      expect(i18n.t('profiles.counts.skills', { count: 1 })).toBe('1 färdighet');
    } finally {
      await i18n.changeLanguage('en');
    }
  });

  it('resolves nothing for an empty list', () => {
    expect(formatProfileCountItems(t, [])).toEqual([]);
  });

  it('inflects the agents count where the language has more than two forms', async () => {
    // Arabic reads a dual for two, the plural for 3-10 and an accusative
    // singular from eleven, so one string for every count cannot agree.
    await i18n.changeLanguage('ar');
    try {
      const agents = (count: number) => formatProfileCountItems(t, [{ kind: 'agents', count }]);
      expect(agents(1)).toEqual(['1 وكيل']);
      expect(agents(2)).toEqual(['2 وكيلان']);
      expect(agents(3)).toEqual(['3 وكلاء']);
      expect(agents(11)).toEqual(['11 وكيلًا']);
    } finally {
      await i18n.changeLanguage('en');
    }

    // Irish keeps the noun singular after a numeral, lenited after 2-6 and
    // eclipsed after 7-10.
    await i18n.changeLanguage('ga');
    try {
      const agents = (count: number) => formatProfileCountItems(t, [{ kind: 'agents', count }]);
      expect(agents(1)).toEqual(['1 gníomhaire']);
      expect(agents(2)).toEqual(['2 ghníomhaire']);
      expect(agents(5)).toEqual(['5 ghníomhaire']);
      expect(agents(7)).toEqual(['7 ngníomhaire']);
      expect(agents(11)).toEqual(['11 gníomhaire']);
    } finally {
      await i18n.changeLanguage('en');
    }

    // Welsh keeps the singular after a numeral and uses the plural only where
    // its `other` category selects it, as the sibling counts do.
    await i18n.changeLanguage('cy');
    try {
      expect(formatProfileCountItems(t, [{ kind: 'agents', count: 2 }])).toEqual(['2 asiant']);
      expect(formatProfileCountItems(t, [{ kind: 'agents', count: 3 }])).toEqual(['3 asiant']);
      expect(formatProfileCountItems(t, [{ kind: 'agents', count: 5 }])).toEqual(['5 asiantau']);
      expect(formatProfileCountItems(t, [{ kind: 'agents', count: 100 }])).toEqual([
        '100 asiantau',
      ]);
    } finally {
      await i18n.changeLanguage('en');
    }

    // Italian takes the partitive in its `many` category, as the sibling
    // counted nouns do, so a large count reads `di agenti`, not `agenti`.
    await i18n.changeLanguage('it');
    try {
      expect(formatProfileCountItems(t, [{ kind: 'agents', count: 2 }])).toEqual(['2 agenti']);
      expect(formatProfileCountItems(t, [{ kind: 'agents', count: 1_000_000 }])).toEqual([
        '1000000 di agenti',
      ]);
    } finally {
      await i18n.changeLanguage('en');
    }
  });

  it('summarizes a draft profile with each count agreed', async () => {
    expect(draftProfileCountItems(2, 0)).toEqual([{ kind: 'vars', count: 2 }]);
    expect(draftProfileCountItems(0, 0)).toEqual([]);

    await i18n.changeLanguage('et');
    try {
      expect(formatProfileCountItems(t, draftProfileCountItems(1, 1))).toEqual([
        '1 muutuja',
        '1 seadistuskäsk',
      ]);
      expect(formatProfileCountItems(t, draftProfileCountItems(3, 2))).toEqual([
        '3 muutujat',
        '2 seadistuskäsku',
      ]);
    } finally {
      await i18n.changeLanguage('en');
    }
  });
});
