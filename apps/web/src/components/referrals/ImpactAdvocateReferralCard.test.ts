import { describe, expect, it } from '@jest/globals';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  IMPACT_ADVOCATE_WIDGET_LOAD_TIMEOUT_MESSAGE,
  IMPACT_ADVOCATE_WIDGET_LOAD_TIMEOUT_MS,
  WidgetFallbackContent,
} from './ImpactAdvocateReferralCard';
import { buildImpactAdvocateTokenUrl } from './ImpactAdvocateReferralCard.utils';

describe('buildImpactAdvocateTokenUrl', () => {
  it('defaults to the KiloClaw Advocate token endpoint for existing callers', () => {
    expect(buildImpactAdvocateTokenUrl()).toBe('/api/impact-advocate/token');
  });

  it('requests the Kilo Pass Advocate token without falling back to KiloClaw config', () => {
    expect(buildImpactAdvocateTokenUrl('kilo_pass')).toBe(
      '/api/impact-advocate/token?product=kilo_pass'
    );
  });
});

describe('WidgetFallbackContent', () => {
  it('replaces the widget loading copy with an ad blocker hint after the load timeout', () => {
    const html = renderToStaticMarkup(
      React.createElement(WidgetFallbackContent, {
        hasTimedOut: true,
      })
    );

    expect(IMPACT_ADVOCATE_WIDGET_LOAD_TIMEOUT_MS).toBe(10_000);
    expect(html).toContain('Referral widget did not load');
    expect(html).toContain(IMPACT_ADVOCATE_WIDGET_LOAD_TIMEOUT_MESSAGE);
    expect(html).toContain('Ad blockers or network filters');
    expect(html).toContain('Either allow the blocked domains');
    expect(html).not.toContain('Allow Kilo');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain('Loading referral widget');
  });

  it('keeps the regular loading copy before the timeout', () => {
    const html = renderToStaticMarkup(
      React.createElement(WidgetFallbackContent, {
        hasTimedOut: false,
      })
    );

    expect(html).toContain('Loading referral widget');
    expect(html).not.toContain('Referral widget did not load');
  });
});
