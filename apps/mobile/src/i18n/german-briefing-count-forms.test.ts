import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';
import { formatNumber } from '@/lib/format';

/**
 * German selects its `other` category at a zero count, so the briefing
 * metadata counters must never read as a singular there. Each family also
 * carries its own inflected noun — `Datei`/`Dateien`, `Zeile`/`Zeilen`,
 * `Schritt`/`Schritten` — and its own placeholder, so the plural selection has
 * to follow the CLDR category of `count`, not the numeral the caller
 * interpolates. Each family is pinned at the counts German distinguishes,
 * including a thousand-scale count that only reads correctly with the locale's
 * grouping separator.
 */

// The catalog is loaded per language by the app's backend, so the language has
// to change once rather than passing `lng` to each call.
beforeAll(async () => {
  await i18n.changeLanguage('de');
});

afterAll(async () => {
  await i18n.changeLanguage('en');
});

const counted = (value: number) => formatNumber(value, 'de');

describe('German briefing metadata counts', () => {
  it('reads a single changed file through the singular form', () => {
    expect(i18n.t('agentBriefing.metadataFiles', { count: 1, displayCount: counted(1) })).toBe(
      '1 Datei geändert'
    );
  });

  it('pluralizes a changed file count above one', () => {
    expect(i18n.t('agentBriefing.metadataFiles', { count: 2, displayCount: counted(2) })).toBe(
      '2 Dateien geändert'
    );
    expect(
      i18n.t('agentBriefing.metadataFiles', { count: 1200, displayCount: counted(1200) })
    ).toBe('1.200 Dateien geändert');
  });

  it('keeps the singular plan step at one and inflects from two', () => {
    expect(
      i18n.t('agentBriefing.metadataPlan', {
        count: 1,
        displayDone: counted(1),
        displayTotal: counted(3),
      })
    ).toBe('Plan: 1 von 3 Schritt erledigt');
    expect(
      i18n.t('agentBriefing.metadataPlan', {
        count: 12,
        displayDone: counted(5),
        displayTotal: counted(12),
      })
    ).toBe('Plan: 5 von 12 Schritten erledigt');
  });

  it('inflects added line counts with the display number', () => {
    expect(i18n.t('agentBriefing.metadataLinesAdded', { count: 1, displayCount: counted(1) })).toBe(
      '1 Zeile hinzugefügt'
    );
    expect(
      i18n.t('agentBriefing.metadataLinesAdded', { count: 200, displayCount: counted(200) })
    ).toBe('200 Zeilen hinzugefügt');
  });

  it('selects by the CLDR category at zero rather than the placeholder', () => {
    expect(i18n.t('agentBriefing.metadataFiles', { count: 0, displayCount: counted(0) })).toBe(
      '0 Dateien geändert'
    );
  });
});
