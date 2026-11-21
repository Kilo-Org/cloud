import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';

/**
 * The Hindi consent disclosures say a small sample of sessions, not sessions
 * that someone chose; the grant row names a grant rather than claiming it was
 * free; the remaining entries keep one wording across their sibling keys.
 */

beforeAll(async () => {
  await i18n.changeLanguage('hi');
});

afterAll(async () => {
  await i18n.changeLanguage('en');
});

describe('Hindi wording that changes the meaning', () => {
  it('describes sampled sessions without implying a choice', () => {
    const screenshots = i18n.t('consent.errorScreenshotsWhat');
    const profiling = i18n.t('consent.performanceProfilingWhat');
    expect(screenshots).toContain('एक छोटे नमूने');
    expect(profiling).toContain('एक छोटे नमूने');
    expect(screenshots).not.toContain('चुने हुए');
    expect(profiling).not.toContain('चुने हुए');
  });

  it('promises without qualification that prompts are never used', () => {
    expect(i18n.t('consent.installAttributionPromptMessage')).toBe(
      'Kilo, Apple की ट्रैकिंग अनुमति का उपयोग केवल यह जानने के लिए करता है कि आप किस माध्यम से यहाँ आए। आपके प्रॉम्प्ट और बातचीत का कभी उपयोग नहीं होता।'
    );
  });

  it('names a credit grant without claiming it was free', () => {
    expect(i18n.t('credits.history.kind.grant')).toBe('क्रेडिट अनुदान');
  });

  it('names the welcome grant as a welcome, not as a purchase', () => {
    expect(i18n.t('credits.history.kind.welcomeCredits')).toBe('स्वागत क्रेडिट');
    expect(i18n.t('credits.history.kind.welcomeCredits')).not.toContain(
      i18n.t('credits.history.kind.purchase')
    );
  });

  it('labels the active-until row with a noun that fits its date value', () => {
    expect(i18n.t('kiloPass.activeUntil')).toBe('सक्रिय रहने की तिथि');
  });

  it('retries a Google Play purchase with the wording of its App Store sibling', () => {
    const play = i18n.t('kiloPass.purchaseDifferentAccountPlay');
    expect(play).not.toContain('फिर फिर');
    expect(play.endsWith('फिर से कोशिश करें।')).toBe(true);
  });

  it('offers the alternative sign-in methods when a passkey fails', () => {
    expect(i18n.t('login.passkeyFailed')).toBe(
      'पासकी से साइन इन नहीं हो सका। इसके बजाय Apple, Google या अपने ईमेल से साइन इन करें।'
    );
  });

  it('uses one term for a paid seat at every count', () => {
    expect(i18n.t('organization.kiloPass.paidSeat', { count: 1, displayCount: '1' })).toBe(
      '1 खरीदी गई सीट'
    );
    expect(i18n.t('organization.kiloPass.paidSeat', { count: 3, displayCount: '3' })).toBe(
      '3 खरीदी गई सीटें'
    );
    expect(i18n.t('organization.kiloPass.overallocated')).toContain('खरीदी गई सीट');
  });

  it('reports one invalid recipient as well as several', () => {
    expect(i18n.t('organization.lowBalanceAlert.emailsInvalid')).toBe(
      'एक या अधिक ईमेल पते मान्य नहीं हैं।'
    );
  });
});
