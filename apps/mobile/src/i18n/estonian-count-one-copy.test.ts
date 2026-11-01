import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';

/**
 * Estonian takes the nominative singular after the numeral one and the
 * partitive singular after zero and two or more, so a counted family whose
 * `_one` entry repeats its `_other` copy never inflects for the count it
 * exists for. Each family below shipped exactly that: `1 faili`, `1 vastet`,
 * `1 tähemärki`. Both categories are pinned here, so a copy that repeats the
 * partitive in `_one` (or the nominative in `_other`) fails.
 */

// The catalog is loaded per language by the app's backend, so the language has
// to change once rather than passing `lng` to each call.
beforeAll(async () => {
  await i18n.changeLanguage('et');
});

afterAll(async () => {
  await i18n.changeLanguage('en');
});

describe('Estonian count-one copy', () => {
  it('inflects the counted noun to the nominative singular at one', () => {
    expect(i18n.t('agentChat.toolCard.filesBadge', { count: 1, displayCount: '1' })).toBe('1 fail');
    expect(i18n.t('agentChat.toolCard.matchesBadge', { count: 1, displayCount: '1' })).toBe(
      '1 vaste'
    );
    expect(i18n.t('agentChat.composer.charactersRemaining', { count: 1 })).toBe(
      '1 tähemärk jäänud'
    );
    expect(
      i18n.t('agentChat.toolRun.condensedLabel', { count: 1, itemCount: '1', last: 'Bash' })
    ).toBe('1 üksus; Bash');
    expect(
      i18n.t('agentChat.attachmentPicker.maxFilesAllowed', { count: 1, displayCount: '1' })
    ).toBe('Lisada saab kuni 1 fail.');
    expect(
      i18n.t('agentChat.attachmentPicker.onlyAddingFiles', {
        count: 1,
        accepted: 1,
        total: 5,
        max: 5,
      })
    ).toBe('Lisatakse ainult 1 fail 5 failist (kuni 5)');
    expect(i18n.t('chat.attachment.limit', { count: 1, displayCount: '1' })).toBe(
      'Võid lisada kuni 1 fail.'
    );
    expect(i18n.t('prReview.checks.checksCount', { count: 1, displayCount: '1' })).toBe(
      '1 kontroll'
    );
    expect(i18n.t('securityAgent.dashboard.findingsCount', { count: 1, displayCount: '1' })).toBe(
      '1 leid'
    );
    expect(i18n.t('securityAgent.auditReport.eventsCount', { count: 1, displayCount: '1' })).toBe(
      '1 sündmus'
    );
    expect(i18n.t('share.onlyFirstFilesAttached', { count: 1, displayCount: '1' })).toBe(
      'Lisatakse ainult esimene 1 fail.'
    );
  });

  it('keeps the partitive at zero and above one', () => {
    expect(i18n.t('agentChat.toolCard.filesBadge', { count: 0, displayCount: '0' })).toBe(
      '0 faili'
    );
    expect(i18n.t('agentChat.toolCard.filesBadge', { count: 2, displayCount: '2' })).toBe(
      '2 faili'
    );
    expect(i18n.t('agentChat.toolCard.matchesBadge', { count: 2, displayCount: '2' })).toBe(
      '2 vastet'
    );
    expect(i18n.t('agentChat.composer.charactersRemaining', { count: 2 })).toBe(
      '2 tähemärki jäänud'
    );
    expect(
      i18n.t('agentChat.toolRun.condensedLabel', { count: 2, itemCount: '2', last: 'Bash' })
    ).toBe('2 üksust; Bash');
    expect(
      i18n.t('agentChat.attachmentPicker.maxFilesAllowed', { count: 2, displayCount: '2' })
    ).toBe('Lisada saab kuni 2 faili.');
    expect(
      i18n.t('agentChat.attachmentPicker.onlyAddingFiles', {
        count: 2,
        accepted: 2,
        total: 5,
        max: 5,
      })
    ).toBe('Lisatakse ainult 2 faili 5 failist (kuni 5)');
    expect(i18n.t('chat.attachment.limit', { count: 2, displayCount: '2' })).toBe(
      'Võid lisada kuni 2 faili.'
    );
    expect(i18n.t('prReview.checks.checksCount', { count: 2, displayCount: '2' })).toBe(
      '2 kontrolli'
    );
    expect(i18n.t('securityAgent.dashboard.findingsCount', { count: 2, displayCount: '2' })).toBe(
      '2 leidu'
    );
    expect(i18n.t('securityAgent.auditReport.eventsCount', { count: 2, displayCount: '2' })).toBe(
      '2 sündmust'
    );
    expect(i18n.t('share.onlyFirstFilesAttached', { count: 2, displayCount: '2' })).toBe(
      'Lisatakse ainult esimesed 2 faili.'
    );
  });

  it('agrees the run count in both directions', () => {
    expect(i18n.t('todos.item.runCount', { count: 1 })).toBe('1 käivitus');
    expect(i18n.t('todos.item.runCount', { count: 2 })).toBe('2 käivitust');
  });

  it('names the spoken dollar without the malformed qualifier', () => {
    expect(i18n.t('agents.sessionRow.dollar', { count: 1 })).toBe('dollar');
    expect(i18n.t('agents.sessionRow.dollar', { count: 2 })).toBe('dollarit');
  });
});
