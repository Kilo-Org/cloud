import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';

/**
 * The Hindi status, glanceable and settings entries had the wrong meaning,
 * word order or agreement: durations were left in English, "preferences" read
 * as "liking", the notification summary claimed it shows activity, and the
 * glanceable count and time phrases put the noun before its postposition.
 */

type Case = { key: string; value: string };

const CASES: Case[] = [
  { key: 'common.durationMinuteShort', value: 'मि' },
  { key: 'common.durationHourShort', value: 'घं' },
  { key: 'common.generating', value: 'जनरेट हो रहा है…' },
  { key: 'common.preferences', value: 'प्राथमिकताएँ' },
  { key: 'consent.loadingConsentSettings', value: 'आपकी सहमति सेटिंग्स लोड हो रही हैं…' },
  {
    key: 'consent.productAnalyticsNote',
    value: 'प्रॉम्प्ट या बातचीत की कोई सामग्री उत्पाद विश्लेषण को नहीं भेजी जाती।',
  },
  { key: 'glanceable.count.needsInput_one', value: '{{displayCount}} को इनपुट चाहिए' },
  { key: 'glanceable.count.needsInput_other', value: '{{displayCount}} को इनपुट चाहिए' },
  { key: 'glanceable.footer.checked', value: 'जाँच · {{time}}' },
  { key: 'glanceable.wake.wasDue', value: '{{time}} को अपेक्षित था' },
  { key: 'glanceable.noActivityFor', value: 'निष्क्रिय समय' },
  { key: 'home.explore', value: 'एक्सप्लोर करें' },
  { key: 'kiloPass.unavailable', value: 'Kilo Pass लोड नहीं हो सका।' },
  { key: 'language.search', value: 'भाषाएँ खोजें' },
  {
    key: 'modelChat.localModels.reasons.androidUnsupportedOs',
    value: 'इस Android संस्करण पर Gemini Nano समर्थित नहीं है।',
  },
  {
    key: 'modelChat.localModels.reasons.androidModelUnavailable',
    value:
      'यह डिवाइस Gemini Nano का समर्थन नहीं करता या AICore सिस्टम ऐप अभी सेट अप हो रहा है। बाद में फिर से कोशिश करें।',
  },
  { key: 'models.auto.organization', value: 'संगठन स्वचालित' },
  {
    key: 'notifications.previewGenericDescription',
    value: 'सूचनाएँ दिखाती हैं कि कुछ हुआ है। इसे पढ़ने के लिए Kilo खोलें।',
  },
];

beforeAll(async () => {
  await i18n.changeLanguage('hi');
});

afterAll(async () => {
  await i18n.changeLanguage('en');
});

describe('Hindi status, glanceable and settings copy', () => {
  it('renders every table entry exactly', () => {
    for (const { key, value } of CASES) {
      if (value.includes('{{')) {
        expect(i18n.t(key, { displayCount: 'X', time: 'X' })).toBe(
          value.replace('{{displayCount}}', 'X').replace('{{time}}', 'X')
        );
      } else {
        expect(i18n.t(key)).toBe(value);
      }
    }
  });

  it('translates short durations and running states into Hindi', () => {
    expect(i18n.t('common.durationMinuteShort')).toBe('मि');
    expect(i18n.t('common.durationHourShort')).toBe('घं');
    expect(i18n.t('common.generating')).toBe('जनरेट हो रहा है…');
  });

  it('names preferences as preferences', () => {
    expect(i18n.t('common.preferences')).toBe('प्राथमिकताएँ');
  });

  it('says plural consent settings are loading', () => {
    expect(i18n.t('consent.loadingConsentSettings')).toBe('आपकी सहमति सेटिंग्स लोड हो रही हैं…');
  });

  it('states that no prompt content reaches product analytics', () => {
    expect(i18n.t('consent.productAnalyticsNote')).toBe(
      'प्रॉम्प्ट या बातचीत की कोई सामग्री उत्पाद विश्लेषण को नहीं भेजी जाती।'
    );
  });

  it('asks for input with the postposition at every count', () => {
    expect(i18n.t('glanceable.count.needsInput', { count: 1, displayCount: '1' })).toBe(
      '1 को इनपुट चाहिए'
    );
    expect(i18n.t('glanceable.count.needsInput', { count: 2, displayCount: '2' })).toBe(
      '2 को इनपुट चाहिए'
    );
  });

  it('puts the checked time after the label', () => {
    expect(i18n.t('glanceable.footer.checked', { time: '10:42' })).toBe('जाँच · 10:42');
  });

  it('puts the due time before its postposition', () => {
    expect(i18n.t('glanceable.wake.wasDue', { time: '10:42' })).toBe('10:42 को अपेक्षित था');
  });

  it('labels the idle duration as idle time', () => {
    expect(i18n.t('glanceable.noActivityFor')).toBe('निष्क्रिय समय');
  });

  it('offers exploration rather than more information', () => {
    expect(i18n.t('home.explore')).toBe('एक्सप्लोर करें');
  });

  it('reports a pass that could not load', () => {
    const unavailable = i18n.t('kiloPass.unavailable');
    expect(unavailable).toBe('Kilo Pass लोड नहीं हो सका।');
    expect(unavailable).not.toContain('उपलब्ध नहीं');
  });

  it('labels the language field as a search', () => {
    expect(i18n.t('language.search')).toBe('भाषाएँ खोजें');
  });

  it('explains an unsupported OS and an unavailable local model', () => {
    expect(i18n.t('modelChat.localModels.reasons.androidUnsupportedOs')).toBe(
      'इस Android संस्करण पर Gemini Nano समर्थित नहीं है।'
    );
    expect(i18n.t('modelChat.localModels.reasons.androidModelUnavailable')).toBe(
      'यह डिवाइस Gemini Nano का समर्थन नहीं करता या AICore सिस्टम ऐप अभी सेट अप हो रहा है। बाद में फिर से कोशिश करें।'
    );
  });

  it('keeps the organization before the automatic qualifier', () => {
    expect(i18n.t('models.auto.organization')).toBe('संगठन स्वचालित');
  });

  it('describes a generic notification without claiming it shows activity', () => {
    const generic = i18n.t('notifications.previewGenericDescription');
    expect(generic).toBe('सूचनाएँ दिखाती हैं कि कुछ हुआ है। इसे पढ़ने के लिए Kilo खोलें।');
    expect(generic).not.toContain('केवल');
    expect(generic).not.toContain('नई गतिविधि');
  });
});
