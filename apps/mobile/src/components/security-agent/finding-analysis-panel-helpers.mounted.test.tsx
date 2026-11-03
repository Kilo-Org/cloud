// Label mapping helpers: known codes render translated catalog labels and
// unknown codes fall back to the humanized raw code, because the analysis
// schema can gain values before the app learns them.

import { i18n } from '@/i18n';

import { describe, expect, it } from 'vitest';

import {
  formatConfidence,
  formatExploitable,
  formatSuggestedAction,
} from './finding-analysis-panel-helpers';

describe('formatConfidence', () => {
  it.each([
    ['high', 'High'],
    ['medium', 'Medium'],
    ['low', 'Low'],
  ])('maps %s to its catalog label', (code, expected) => {
    expect(formatConfidence(code)).toBe(expected);
  });

  it('falls back to the humanized code for an unknown value', () => {
    expect(formatConfidence('very_high')).toBe('very high');
  });

  it('does not return inherited members for prototype names', () => {
    expect(formatConfidence('constructor')).toBe('constructor');
    expect(formatConfidence('toString')).toBe('toString');
  });
});

describe('formatSuggestedAction', () => {
  it.each([
    ['dismiss', 'Dismiss'],
    ['analyze_codebase', 'Analyze codebase'],
    ['manual_review', 'Manual review'],
    ['open_pr', 'Open PR'],
    ['monitor', 'Monitor'],
  ])('maps %s to its catalog label', (code, expected) => {
    expect(formatSuggestedAction(code)).toBe(expected);
  });

  it('falls back to the humanized code for an unknown value', () => {
    expect(formatSuggestedAction('escalate_now')).toBe('escalate now');
  });

  it('does not return inherited members for prototype names', () => {
    expect(formatSuggestedAction('constructor')).toBe('constructor');
    expect(formatSuggestedAction('__proto__')).toBe('  proto  ');
  });

  // A stored analysis can omit the field the row reads: the column is jsonb
  // behind a compile-time type, so the row must label the gap, not throw.
  it.each([undefined, null, '', '   ', 7 as unknown as string])(
    'labels an absent code (%j) as not recorded',
    value => {
      expect(formatSuggestedAction(value)).toBe(i18n.t('securityAgent.analysis.notRecorded'));
      expect(formatConfidence(value)).toBe(i18n.t('securityAgent.analysis.notRecorded'));
    }
  );

  it('re-reads the catalog after a language change', async () => {
    await i18n.changeLanguage('ar');
    try {
      expect(formatSuggestedAction('manual_review')).toBe(
        i18n.t('securityAgent.analysis.action.manualReview')
      );
    } finally {
      await i18n.changeLanguage('en');
    }
  });
});

describe('formatExploitable', () => {
  it.each([undefined, null, 'unknown' as const])(
    'reads %j as unknown rather than asserting an answer',
    value => {
      expect(formatExploitable(value)).toBe(i18n.t('common.unknown'));
    }
  );

  it.each([
    [true, 'securityAgent.analysis.yes'],
    [false, 'securityAgent.analysis.no'],
  ] as const)('maps %s to its catalog label', (value, key) => {
    expect(formatExploitable(value)).toBe(i18n.t(key));
  });
});
