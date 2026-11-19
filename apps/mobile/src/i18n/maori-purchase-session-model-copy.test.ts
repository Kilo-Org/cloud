import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';

/**
 * The Māori catalog named the same purchase two ways inside the credits
 * warnings, worded the device-session timestamp with a passive verb instead of
 * the `whakamutunga` modifier, gave one "Finished" state two completion verbs
 * on the glanceable card, dropped the infinitive marker from the permission
 * caption, and made Kilo Pass the agent of its own loading failure instead of
 * the thing loaded. It also called the brand mark a `moko`, shipped both the
 * model-backends "Messages" label and the Auto Frontier tier label in the
 * wrong form, commanded a download where the row describes one, split the chat
 * noun between `kōrero` and `kōrerorero`, invited a retry with a second verb,
 * and phrased the groups empty state with a definite article.
 *
 * These assertions pin the corrected copy, so a later edit cannot silently
 * restore it.
 */

beforeAll(async () => {
  await i18n.changeLanguage('mi');
});

afterAll(async () => {
  await i18n.changeLanguage('en');
});

describe('Māori purchase notices', () => {
  it('names the transaction with one purchase noun in both notices', () => {
    const pending = i18n.t('credits.unresolvedPurchase');
    const credited = i18n.t('credits.unresolvedPurchaseCredited');
    expect(credited).toBe(
      'Kua whakaurua tētahi hokonga o mua ki tō pūkete. Tērā pea ka oti tonu tētahi atu utu mai i taua wāhanga anō, nō reira ka tīmata tētahi hokonga hou mēnā ka hoko anō koe, ā, tērā pea ka tangohia anō he utu i a koe.'
    );
    expect(pending).toContain('hokonga hou');
    expect(credited).toContain('hokonga hou');
    expect(credited).not.toMatch(/\btētahi hoko (o mua|hou)\b/);
  });
});

describe('Māori device-session timestamps', () => {
  it('renders the last-seen time with the whakamutunga modifier', () => {
    const lastSeen = '12 Noe 2026, 3:45 PM';
    const signedIn = i18n.t('deviceSessions.signedIn', { signedIn: '1 Noe 2026', lastSeen });
    const label = i18n.t('deviceSessions.signOutSessionLabel', {
      device: 'Waea a Ana',
      signedIn: '1 Noe 2026',
      lastSeen,
    });
    const message = i18n.t('deviceSessions.signOutThisSessionMessage', {
      device: 'Waea a Ana',
      lastSeen,
    });
    expect(signedIn).toBe(`I takiuru i te 1 Noe 2026 · I kitea whakamutunga i te ${lastSeen}`);
    expect(label).toBe(
      `Takiputa i a Waea a Ana, i takiuru i te 1 Noe 2026, i kitea whakamutunga i te ${lastSeen}`
    );
    expect(message).toContain(`I kitea whakamutunga i te ${lastSeen}.`);
    for (const line of [signedIn, label, message]) {
      expect(line).not.toContain('whakamutungatia');
    }
  });
});

describe('Māori glanceable session card', () => {
  it('uses one completion verb for the finished state and its duration', () => {
    expect(i18n.t('glanceable.finished')).toBe('Kua mutu');
    expect(i18n.t('glanceable.finishedIn', { duration: '2 meneti' })).toBe(
      'Kua mutu i roto i 2 meneti'
    );
  });

  it('marks the permission caption as an infinitive', () => {
    expect(i18n.t('glanceable.permissionWants')).toBe('Kei te hiahia ki te whakahaere');
  });
});

describe('Māori Kilo Pass load failure', () => {
  it('marks the pass as the thing that failed to load', () => {
    expect(i18n.t('kiloPass.unavailable')).toBe('Kāore i taea te uta i a Kilo Pass.');
    expect(i18n.t('kiloPass.couldNotLoad')).toBe(
      'Kāore i taea te uta i a Kilo Pass. Whakamātau anō.'
    );
  });
});

describe('Māori brand mark label', () => {
  it('names the image with the mark noun', () => {
    expect(i18n.t('login.logo')).toBe('Tohu Kilo');
  });
});

describe('Māori model chat copy', () => {
  it('describes the download size instead of commanding a download', () => {
    expect(i18n.t('modelChat.catalog.quantDetail', { size: '2.1 GB', memory: '4 GB' })).toBe(
      '2.1 GB te tikiake · tata ki te 4 GB o te mahara'
    );
  });

  it('compares the device memory with its o-class possessive', () => {
    expect(i18n.t('modelChat.catalog.tooLargeMessage', { name: 'Kilo 7B' })).toBe(
      'Tērā pea ka nui ake te mahara e hiahiatia ana e Kilo 7B i tō tēnei pūrere. Ka kati pea te taupānga i te wā e whakautu ana te tauira. Me tikiake tonu?'
    );
  });

  it('names the chat with the modelChat chat noun in the empty state', () => {
    expect(i18n.t('modelChat.empty.title')).toBe('Tīmata he kōrerorero');
    expect(i18n.t('modelChat.empty.description')).toBe(
      'Tukuna he karere hei kōrerorero ki tētahi tauira.'
    );
  });

  it('invites the retry with the catalog retry verb', () => {
    expect(i18n.t('modelChat.offlineFailure')).toBe(
      'Me whai hononga ipurangi tēnei tauira. Tūhono, ka whakamātau anō, kia huri rānei ki tētahi tauira i tēnei pūrere.'
    );
  });
});

describe('Māori tier labels and groups empty state', () => {
  it('capitalizes both words of the frontier tier label', () => {
    expect(i18n.t('models.auto.frontier')).toBe('Aunoa Pae Whakamua');
  });

  it('states that no groups exist yet', () => {
    expect(i18n.t('organization.groups.emptyTitle')).toBe('Kāore anō he kāhui');
  });
});
