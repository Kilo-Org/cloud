/* eslint-disable eslint-plugin-import/no-nodejs-modules -- the scan contract is exercised against a fixture tree on disk, which only exists in the vitest runner */
import { type TFunction } from 'i18next';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  collectCountedKeys,
  collectDynamicCountedCalls,
  DYNAMIC_COUNTED_KEYS,
  findCountlessFamilies,
  findUnlistedDynamicCalls,
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

  it('collects double-quoted and static template-literal counted keys', () => {
    const root = mkdtempSync(join(tmpdir(), 'check-plurals-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(
      join(root, 'src', 'fixture.ts'),
      [
        `t("fixture.doubleQuoted", { count: 1 });`,
        't(`fixture.backticked`, { count: 2 });',
        `t('fixture.singleQuoted', { count: 3 });`,
        `t(dynamicKey, { count: 4 });`,
        `t('fixture.notCounted');`,
      ].join('\n')
    );
    try {
      // collectCountedKeys sorts its output, so the fixture order is already stable.
      expect(collectCountedKeys(root)).toEqual([
        'fixture.backticked',
        'fixture.doubleQuoted',
        'fixture.singleQuoted',
      ]);
      expect(collectDynamicCountedCalls(root)).toEqual(['dynamicKey']);
      // The fixture expression is not in the allowlist, so the audit reports it.
      expect(findUnlistedDynamicCalls(root)).toEqual(['dynamicKey']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reviews every dynamic counted call and checks its possible keys', () => {
    expect(findUnlistedDynamicCalls()).toEqual([]);
    // `findCountlessFamilies` above walks the allowlist's keys too, so a stale
    // entry fails the family check. Here only the entries' shape is pinned.
    for (const [expression, listed] of DYNAMIC_COUNTED_KEYS) {
      expect(listed.keys.length, expression).toBeGreaterThan(0);
      expect(listed.reason.length, expression).toBeGreaterThan(0);
    }
  });

  it('selects the singular form of a dynamic family at count 1', () => {
    // serverToolCount is reachable only through the reviewed `row.statusKey`
    // call; the count picks its form like any literal key's.
    expect(t('modelChat.mcp.serverToolCount', { count: 1 })).toBe('1 tool');
    expect(t('modelChat.mcp.serverToolCount', { count: 5 })).toBe('5 tools');
    expect(t('profiles.counts.vars', { count: 1 })).toBe('1 var');
    expect(t('profiles.counts.commands', { count: 5 })).toBe('5 cmds');
  });
});
