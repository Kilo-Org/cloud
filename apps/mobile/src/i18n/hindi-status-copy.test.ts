import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';

/**
 * The Hindi status, glanceable and settings entries had the wrong meaning,
 * word order or agreement: durations were left in English, "preferences" read
 * as "liking", the generic notification preview claimed to show activity, and
 * the glanceable count and clock phrases put the noun before its postposition.
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
  it('renders every corrected entry exactly', () => {
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

  it('asks for input with the postposition at every count', () => {
    expect(i18n.t('glanceable.count.needsInput', { count: 1, displayCount: '1' })).toBe(
      '1 को इनपुट चाहिए'
    );
    expect(i18n.t('glanceable.count.needsInput', { count: 2, displayCount: '2' })).toBe(
      '2 को इनपुट चाहिए'
    );
  });

  it('keeps the clock value in Hindi order', () => {
    expect(i18n.t('glanceable.footer.checked', { time: '10:42' })).toBe('जाँच · 10:42');
    expect(i18n.t('glanceable.wake.wasDue', { time: '10:42' })).toBe('10:42 को अपेक्षित था');
  });

  it('reports a pass that could not load rather than an unavailable one', () => {
    expect(i18n.t('kiloPass.unavailable')).not.toContain('उपलब्ध नहीं');
  });

  it('describes a generic notification without claiming it shows activity', () => {
    const generic = i18n.t('notifications.previewGenericDescription');
    expect(generic).not.toContain('केवल');
    expect(generic).not.toContain('नई गतिविधि');
  });
});
