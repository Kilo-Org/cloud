import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';

/**
 * Hindi wording corrections. Each entry below disagreed with its English
 * source: a replacement narrowed to another device, a singular noun paired
 * with a plural auxiliary, a fallback in the direct case inside an oblique
 * `द्वारा` slot, a plural adjective in the one category, an empty state that
 * named only link hosts, "offline" read as a property of the produced text,
 * and a voice-input notice that stopped before its remediation sentence.
 */

beforeAll(async () => {
  await i18n.changeLanguage('hi');
});

afterAll(async () => {
  await i18n.changeLanguage('en');
});

describe('Hindi share copy', () => {
  it('leaves the replacement place-neutral', () => {
    expect(i18n.t('sessionShare.superseded')).toBe(
      'यह लिंक कहीं और से बदल दिया गया है, इसलिए यह अब काम नहीं करता।'
    );
  });

  it('agrees the one-file notice with its singular noun', () => {
    const one = i18n.t('share.onlyFirstFilesAttached', { count: 1, displayCount: '1' });
    const many = i18n.t('share.onlyFirstFilesAttached', { count: 3, displayCount: '3' });
    expect(one).toBe('केवल पहली 1 फ़ाइल संलग्न की जाएगी।');
    expect(many).toBe('केवल पहली 3 फ़ाइलें संलग्न की जाएँगी।');
  });
});

describe('Hindi shared-session copy', () => {
  it('composes the shared-by line in the oblique case when the owner is unknown', () => {
    expect(i18n.t('sharedSession.sharedBy', { owner: i18n.t('sharedSession.someone') })).toBe(
      'किसी व्यक्ति द्वारा शेयर किया गया'
    );
  });
});

describe('Hindi to-do copy', () => {
  it('inflects the open count to the singular in the one category', () => {
    expect(i18n.t('todos.lists.openCount', { count: 1 })).toBe('1 खुला');
    expect(i18n.t('todos.lists.openCount', { count: 3 })).toBe('3 खुले');
  });

  it('keeps the plural wording for an empty list, which CLDR routes into the one category', () => {
    expect(i18n.t('todos.lists.openCount', { count: 0 })).toBe('0 खुले');
  });
});

describe('Hindi trusted-host and voice copy', () => {
  it('names both host kinds in the empty state', () => {
    expect(i18n.t('trustedHosts.emptyDescription')).toBe(
      'जब आप किसी लिंक के होस्ट या किसी छवि होस्ट पर भरोसा करते हैं, तो वह बिना दोबारा पूछे खुल जाता है।'
    );
  });

  it('states offline as the condition on transcription', () => {
    expect(i18n.t('voiceInput.onlineMessage', { provider: 'Google' })).toBe(
      'यह डिवाइस ऑफ़लाइन आवाज़ को टेक्स्ट में नहीं बदल सकता। आपकी रिकॉर्डिंग टेक्स्ट में बदलने के लिए Google को भेजी जाती है। Kilo ऑडियो सहेजकर नहीं रखता।'
    );
  });

  it('keeps both recovery paths in the unavailable-language notice', () => {
    expect(i18n.t('voiceInput.unavailableLanguage')).toBe(
      'इस डिवाइस की भाषा के लिए वॉइस इनपुट उपलब्ध नहीं है। इसकी ऑफ़लाइन स्पीच फ़ाइलें इंस्टॉल करें या ऐप की कोई दूसरी भाषा इस्तेमाल करें।'
    );
  });
});
