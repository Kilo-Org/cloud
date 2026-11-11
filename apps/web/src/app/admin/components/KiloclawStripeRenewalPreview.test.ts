import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from '@jest/globals';

import { KiloclawStripeRenewalPreview } from './KiloclawStripeRenewalPreview';

describe('KiloclawStripeRenewalPreview', () => {
  it('leads with the renewing count and then the skipped breakdown', () => {
    const html = renderToStaticMarkup(
      React.createElement(KiloclawStripeRenewalPreview, {
        counts: { renewing: 44, alreadyEnding: 22, canceled: 568, total: 634 },
      })
    );

    expect(html).toContain('44</strong> subscriptions are currently set to renew');
    expect(html).toContain(
      '22 already ending and 568 canceled will be checked and skipped (634 total).'
    );
    expect(html.indexOf('currently set to renew')).toBeLessThan(html.indexOf('already ending'));
  });

  it('states that nothing is renewing when the renewing count is zero', () => {
    const html = renderToStaticMarkup(
      React.createElement(KiloclawStripeRenewalPreview, {
        counts: { renewing: 0, alreadyEnding: 22, canceled: 568, total: 590 },
      })
    );

    expect(html).toContain('No subscriptions are currently set to renew.');
    expect(html).toContain('22 already ending and 568 canceled will be checked and skipped');
  });
});
