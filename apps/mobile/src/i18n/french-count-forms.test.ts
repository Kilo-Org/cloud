import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';
import { formatNumber } from '@/lib/format';

/**
 * French selects its `one` category at a zero count, and its `many` category
 * only at the million scale. A `_zero` entry therefore never states a French
 * form, and a `_many` entry that repeats `_other` never serves the one count
 * range only it can render. The families below shipped both defects: the
 * repository and severity counters declared a plural `_zero` copy, the
 * findings, overdue and queued counts kept an `_other` copy under `_many`, and
 * the due-soon detail agreed its participle with the plural at a count of one.
 * Each touched family is pinned at the counts its rules distinguish, so a copy
 * that restates the plural form at zero, drops the partitive `de`, or
 * flattens the singular detail fails here.
 */

// The catalog is loaded per language by the app's backend, so the language has
// to change once rather than passing `lng` to each call.
beforeAll(async () => {
  await i18n.changeLanguage('fr');
});

afterAll(async () => {
  await i18n.changeLanguage('en');
});

const counted = (value: number) => formatNumber(value, 'fr');

describe('French Security Agent counts', () => {
  it('reads a zero repository count through the singular form', () => {
    expect(
      i18n.t('securityAgent.dashboard.repoSummaryOpen', { count: 0, displayCount: counted(0) })
    ).toBe('0 ouvert');
    expect(
      i18n.t('securityAgent.dashboard.repoSummaryCritical', { count: 0, displayCount: counted(0) })
    ).toBe('0 critique');
    expect(
      i18n.t('securityAgent.dashboard.repoSummaryHigh', { count: 0, displayCount: counted(0) })
    ).toBe('0 de gravité élevée');
  });

  it('pluralizes a repository count above one', () => {
    expect(
      i18n.t('securityAgent.dashboard.repoSummaryOpen', { count: 2, displayCount: counted(2) })
    ).toBe('2 ouverts');
    expect(
      i18n.t('securityAgent.dashboard.repoSummaryCritical', { count: 2, displayCount: counted(2) })
    ).toBe('2 critiques');
    expect(
      i18n.t('securityAgent.dashboardMetrics.breakdownCritical', {
        count: 2,
        displayCount: counted(2),
      })
    ).toBe('2 de niveau critique');
  });

  it('puts the partitive before a million-scale count', () => {
    const many = 1_000_000;
    expect(
      i18n.t('securityAgent.dashboard.findingsCount', { count: many, displayCount: counted(many) })
    ).toBe(`${counted(many)} de signalements`);
    expect(
      i18n.t('securityAgent.dashboard.daysOverdue', { count: many, displayCount: counted(many) })
    ).toBe(`${counted(many)} de jours de retard`);
    expect(
      i18n.t('securityAgent.automation.queued', { count: many, displayCount: counted(many) })
    ).toBe(`${counted(many)} de signalements déjà détectés mis en file d'attente pour analyse.`);
  });

  it('names the queued findings one way at one and above one', () => {
    expect(i18n.t('securityAgent.automation.queued', { count: 1, displayCount: counted(1) })).toBe(
      "1 signalement déjà détecté ajouté à la file d'attente d'analyse."
    );
    expect(i18n.t('securityAgent.automation.queued', { count: 2, displayCount: counted(2) })).toBe(
      "2 signalements déjà détectés ont été mis en file d'attente pour analyse."
    );
  });

  it('agrees the due-soon detail with a single exploited finding', () => {
    expect(
      i18n.t('securityAgent.dashboardMetrics.dueThisWeekDetail', {
        count: 1,
        exploitable: counted(1),
      })
    ).toBe('Dont 1 confirmé exploitable');
    expect(
      i18n.t('securityAgent.dashboardMetrics.dueThisWeekDetail', {
        count: 2,
        exploitable: counted(2),
      })
    ).toBe('Dont 2 confirmés exploitables');
  });
});

describe('catalogs with no zero category', () => {
  /**
   * These catalogs select `one` at a zero count and inflect no word of the six
   * Security Agent count families between the two forms, so a zero entry only
   * repeated its `one` sibling. The same display token on both calls isolates
   * the wording from the number.
   */
  const tags = ['am', 'bn', 'fa', 'fil', 'gu', 'hi', 'kn', 'mg', 'pa', 'si', 'zu'] as const;
  const families = [
    'securityAgent.dashboard.repoSummaryOpen',
    'securityAgent.dashboard.repoSummaryCritical',
    'securityAgent.dashboard.repoSummaryHigh',
    'securityAgent.dashboardMetrics.breakdownCritical',
    'securityAgent.dashboardMetrics.breakdownHigh',
    'securityAgent.dashboardMetrics.breakdownMediumLow',
  ] as const;

  it('renders a zero count with the wording its one form carries', async () => {
    for (const tag of tags) {
      await i18n.changeLanguage(tag);
      for (const family of families) {
        expect(i18n.t(family, { count: 0, displayCount: 'N' })).toBe(
          i18n.t(family, { count: 1, displayCount: 'N' })
        );
      }
    }
    await i18n.changeLanguage('fr');
  });
});
