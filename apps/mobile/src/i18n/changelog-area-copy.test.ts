import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';
import { formatList } from '@/lib/format';

/**
 * The changelog's fixes line names each area in the middle of a sentence, so
 * every area reads from its own `profile.changelogAreas.*` value instead of the
 * capitalized chrome label it used to reuse. These cases pin the casing each
 * catalog supplies for that slot: English and Portuguese lower the noun,
 * German keeps its capital, and Azerbaijani capitalizes the area because it
 * opens the sentence there.
 */

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

afterAll(async () => {
  await i18n.changeLanguage('en');
});

describe('English changelog areas', () => {
  it('names the areas in lower case inside the sentence', async () => {
    await i18n.changeLanguage('en');
    // The two agent products keep their Latin names; the third renders from
    // the catalog, which is the value under test.
    const areas = ['Cloud Agent', 'Security Agent', i18n.t('profile.changelogAreas.notifications')];
    expect(i18n.t('profile.changelogFixesIn', { areas: formatList(areas, 'en') })).toBe(
      'Fixes and improvements in Cloud Agent, Security Agent, and notifications.'
    );
  });
});

describe('Portuguese changelog areas', () => {
  it('lowercases the notification noun in a three-area sentence', async () => {
    await i18n.changeLanguage('pt-BR');
    const areas = ['Cloud Agent', 'Security Agent', i18n.t('profile.changelogAreas.notifications')];
    expect(i18n.t('profile.changelogFixesIn', { areas: formatList(areas, 'pt-BR') })).toBe(
      'Correções e melhorias em Cloud Agent, Security Agent e notificações.'
    );
  });

  it('reads as a sentence with only the notifications area', async () => {
    await i18n.changeLanguage('pt-BR');
    const areas = [i18n.t('profile.changelogAreas.notifications')];
    expect(i18n.t('profile.changelogFixesIn', { areas: formatList(areas, 'pt-BR') })).toBe(
      'Correções e melhorias em notificações.'
    );
  });
});

describe('German changelog areas', () => {
  it('keeps the capitalized noun', async () => {
    await i18n.changeLanguage('de');
    const areas = ['Cloud Agent', 'Security Agent', i18n.t('profile.changelogAreas.notifications')];
    expect(i18n.t('profile.changelogFixesIn', { areas: formatList(areas, 'de') })).toBe(
      'Fehlerbehebungen und Verbesserungen in den Bereichen Cloud Agent, Security Agent und Benachrichtigungen.'
    );
  });
});

describe('Azerbaijani changelog areas', () => {
  it('keeps the capital the area needs at the start of the sentence', async () => {
    await i18n.changeLanguage('az');
    const areas = ['Cloud Agent', 'Security Agent', i18n.t('profile.changelogAreas.notifications')];
    expect(i18n.t('profile.changelogFixesIn', { areas: formatList(areas, 'az') })).toBe(
      'Cloud Agent, Security Agent və Bildirişlər bölmələrində düzəlişlər və təkmilləşdirmələr.'
    );
  });
});
