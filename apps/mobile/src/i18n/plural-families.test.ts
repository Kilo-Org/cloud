import { type TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';

import {
  collectCountedKeys,
  findCountlessFamilies,
  NO_AGREEMENT,
} from '../../../../tools/i18n/check-plurals.mjs';
import { i18n } from '@/i18n';

const t = i18n.t as TFunction;

/** `t` with `returnDetails`, so a test can see which plural category resolved. */
function resolveKey(key: string, options: Record<string, unknown>) {
  return t(key, { ...options, returnDetails: true }) as unknown as {
    res: string;
    exactUsedKey: string;
  };
}

/**
 * The rows the pre-fix repro captured: one invariant string for every count.
 * Each now hands i18next a `count`, so English resolves its `_one` form.
 */
const PRE_FIX_ROWS: { key: string; options: Record<string, unknown> }[] = [
  {
    key: 'agentChat.toolRun.condensedLabel',
    options: { count: 1, itemCount: '1', last: 'Grep' },
  },
  { key: 'agentChat.toolCard.linesBadge', options: { count: 1, displayCount: '1' } },
  { key: 'prReview.checks.checksCount', options: { count: 1, displayCount: '1' } },
  { key: 'securityAgent.dashboard.daysOverdue', options: { count: 1, displayCount: '1' } },
];

describe('plural families', () => {
  it('declares a family (or a reviewed exemption) for every counted key', () => {
    // A non-trivial scan, so the assertion below cannot pass by finding nothing.
    expect(collectCountedKeys().length).toBeGreaterThan(10);
    expect(findCountlessFamilies()).toEqual([]);
  });

  it('keeps every NO_AGREEMENT entry documented with a reason', () => {
    for (const [key, reason] of NO_AGREEMENT) {
      expect(reason.length, key).toBeGreaterThan(0);
    }
  });

  it('selects the count form for a condensed tool run in English', () => {
    expect(t('agentChat.toolRun.condensedLabel', { count: 1, itemCount: '1', last: 'Grep' })).toBe(
      '1 item; Grep'
    );
    expect(t('agentChat.toolRun.condensedLabel', { count: 2, itemCount: '2', last: 'Grep' })).toBe(
      '2 items; Grep'
    );
  });

  it('resolves a plural family for each counted row that shipped one form', () => {
    for (const { key, options } of PRE_FIX_ROWS) {
      const details = resolveKey(key, options);
      expect(details.exactUsedKey, key).toBe(`${key}_one`);
    }
  });
});
