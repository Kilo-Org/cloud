// Label mapping helpers: known codes render translated catalog labels and
// unknown codes fall back to the humanized raw code, because the analysis
// schema can gain values before the app learns them.

import { i18n } from '@/i18n';

import { describe, expect, it } from 'vitest';

import { formatConfidence, formatSuggestedAction } from './finding-analysis-panel-helpers';

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
