import { describe, expect, it } from 'vitest';

import {
  getAccessRequiredOpenUrl,
  getAccessRequiredPresentation,
} from './access-required-presentation';

describe('getAccessRequiredPresentation', () => {
  it('removes subscription web CTAs on iOS', () => {
    expect(getAccessRequiredPresentation('trial_expired', 'ios')).toEqual({
      title: 'KiloClaw unavailable in iOS',
      body: 'KiloClaw access is not available in the iOS app for this account. Manage KiloClaw from your Kilo account on another device.',
      ctaLabel: null,
      ctaVariant: null,
    });
  });

  it('removes account review web CTAs on iOS', () => {
    expect(getAccessRequiredPresentation('multiple_current_conflict', 'ios')).toEqual({
      title: 'Account needs review',
      body: 'This KiloClaw account state needs review before it can be used in the iOS app.',
      ctaLabel: null,
      ctaVariant: null,
    });
  });

  it('keeps the web CTA off iOS', () => {
    expect(getAccessRequiredPresentation('trial_expired', 'android')).toEqual({
      title: 'Subscribe on the web',
      body: "To keep using KiloClaw, go to kilo.ai/claw from your browser. You can't subscribe in the app.",
      ctaLabel: 'Open kilo.ai/claw',
      ctaVariant: 'default',
    });
  });
});

describe('getAccessRequiredOpenUrl', () => {
  it('opens the KiloClaw page for subscription cases', () => {
    expect(getAccessRequiredOpenUrl('trial_expired', 'https://kilo.ai')).toBe(
      'https://kilo.ai/claw'
    );
  });

  it('opens the account page for non-subscription cases', () => {
    expect(getAccessRequiredOpenUrl('quarantined', 'https://kilo.ai')).toBe('https://kilo.ai');
  });
});
