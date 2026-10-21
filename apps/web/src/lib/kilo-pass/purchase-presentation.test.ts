import { describe, expect, it } from '@jest/globals';

import { APP_URL } from '@kilocode/web-shared/lib/constants';
import { KiloPassPaymentProvider } from '@kilocode/web-shared/lib/kilo-pass/enums';
import { buildPurchasePresentation } from '@/lib/kilo-pass/purchase-presentation';
import {
  KILO_PASS_MANAGE_CTA_LABEL,
  type KiloPassSubscriptionStatus,
} from '@kilocode/app-shared/commerce';

function stripeSub(status: KiloPassSubscriptionStatus) {
  return { paymentProvider: KiloPassPaymentProvider.Stripe, status };
}

describe('buildPurchasePresentation', () => {
  it.each([
    ['ios', 'app_store'],
    ['android', 'play'],
  ] as const)(
    'maps %s %s Kilo Pass without a Stripe sub to unavailable',
    (platform, storefront) => {
      const result = buildPurchasePresentation({
        subscription: null,
        input: { platform, storefront, product: 'kilo_pass' },
      });

      expect(result.kind).toBe('unavailable');
      expect(result.statusClass).toBe('inactive');
      expect(result.reason).toBe('kilo_pass_not_sold_in_app');
      expect(result.cta).toEqual({ label: null, action: 'none' });
      expect(result.webUrl).toBeNull();
    }
  );

  it('maps a live store subscriber to unavailable, so the app cannot start another purchase', () => {
    const result = buildPurchasePresentation({
      subscription: { paymentProvider: KiloPassPaymentProvider.AppStore, status: 'active' },
      input: { platform: 'ios', storefront: 'app_store', product: 'kilo_pass' },
    });

    expect(result.kind).toBe('unavailable');
    expect(result.statusClass).toBe('healthy');
    expect(result.reason).toBe('kilo_pass_not_sold_in_app');
  });

  it('gives iOS no web link, even for a live Stripe sub', () => {
    const result = buildPurchasePresentation({
      subscription: stripeSub('active'),
      input: { platform: 'ios', storefront: 'app_store', product: 'kilo_pass' },
    });

    expect(result.kind).toBe('unavailable');
    expect(result.webUrl).toBeNull();
  });

  it('maps Android Kilo Pass with a live Stripe sub to web_management', () => {
    const result = buildPurchasePresentation({
      subscription: stripeSub('active'),
      input: { platform: 'android', storefront: 'play', product: 'kilo_pass' },
    });

    expect(result.kind).toBe('web_management');
    expect(result.reason).toBeNull();
    expect(result.cta).toEqual({ label: KILO_PASS_MANAGE_CTA_LABEL, action: 'open_web' });
    expect(result.webUrl).toBe(`${APP_URL}/subscriptions/kilo-pass`);
  });

  it('maps Android credits to web_management with the credits web URL', () => {
    const result = buildPurchasePresentation({
      subscription: null,
      input: { platform: 'android', storefront: 'play', product: 'credits' },
    });

    expect(result.kind).toBe('web_management');
    expect(result.cta).toEqual({ label: KILO_PASS_MANAGE_CTA_LABEL, action: 'open_web' });
    expect(result.webUrl).toBe(`${APP_URL}/credits`);
  });

  it('maps iOS credits to unavailable', () => {
    const result = buildPurchasePresentation({
      subscription: null,
      input: { platform: 'ios', storefront: 'app_store', product: 'credits' },
    });

    expect(result.kind).toBe('unavailable');
    expect(result.reason).toBe('credits_not_sold_on_ios');
    expect(result.cta).toEqual({ label: null, action: 'none' });
  });

  it('maps a missing platform to unavailable', () => {
    const result = buildPurchasePresentation({
      subscription: null,
      input: { platform: null, storefront: 'web', product: 'kilo_pass' },
    });

    expect(result.kind).toBe('unavailable');
    expect(result.reason).toBe('unsupported_combination');
  });

  it('echoes the program without changing the kind', () => {
    const result = buildPurchasePresentation({
      subscription: null,
      input: {
        platform: 'ios',
        storefront: 'app_store',
        product: 'kilo_pass',
        program: 'impact',
      },
    });

    expect(result.kind).toBe('unavailable');
    expect(result.program).toBe('impact');
  });

  it.each([
    ['active', 'healthy'],
    ['incomplete', 'pending'],
    ['trialing', 'pending'],
    ['past_due', 'retryable'],
    ['canceled', 'terminal'],
    ['incomplete_expired', 'terminal'],
    ['unpaid', 'terminal'],
    ['paused', 'inactive'],
  ] as const)('maps subscription status %s to statusClass %s', (status, expected) => {
    const result = buildPurchasePresentation({
      subscription: stripeSub(status),
      input: { platform: 'ios', storefront: 'app_store', product: 'kilo_pass' },
    });

    expect(result.statusClass).toBe(expected);
  });

  it('treats an ended Stripe sub as not Stripe-managed on Android', () => {
    const result = buildPurchasePresentation({
      subscription: stripeSub('canceled'),
      input: { platform: 'android', storefront: 'play', product: 'kilo_pass' },
    });

    expect(result.kind).toBe('unavailable');
    expect(result.reason).toBe('kilo_pass_not_sold_in_app');
  });
});
