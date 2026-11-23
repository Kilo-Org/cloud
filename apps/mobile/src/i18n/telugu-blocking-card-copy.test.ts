import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';

/**
 * Telugu blocking-card captions. Both replaced a first-person future action
 * ("we will stop sending your message") with the state the English entry
 * states: the sending of the message is paused while the request is open.
 * The Telugu sibling announcements already describe the paused state without an
 * actor, so the captions now agree with them. Catalog values only: no key,
 * placeholder, or plural category moves.
 */

beforeAll(async () => {
  await i18n.changeLanguage('te');
});

afterAll(async () => {
  await i18n.changeLanguage('en');
});

describe('Telugu blocking-card captions', () => {
  it('states the paused message as a state, not a promise', () => {
    expect(i18n.t('agentChat.blockingCard.waitingForAnswer')).toBe(
      'ఏజెంట్ మీ సమాధానం కోసం వేచి ఉంది. ఈ ప్రశ్న తెరిచి ఉన్నంత వరకు ఏజెంట్‌కు మీ సందేశం పంపడం నిలిపివేయబడింది.'
    );
  });

  it('states the paused message for a permission request the same way', () => {
    expect(i18n.t('agentChat.blockingCard.waitingForPermission')).toBe(
      'ఈ అభ్యర్థన తెరిచి ఉన్నంత వరకు ఏజెంట్‌కు మీ సందేశం పంపడం నిలిపివేయబడింది.'
    );
  });
});