import React from 'react';
import { describe, expect, it } from '@jest/globals';
import { renderToStaticMarkup } from 'react-dom/server';

import { EarlyFraudWarningsTable, type EarlyFraudWarningRow } from './EarlyFraudWarningsContent';

const rows = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    stripeEarlyFraudWarningId: 'issfr_personal',
    stripeEventId: 'evt_personal',
    stripeChargeId: 'ch_personal',
    stripePaymentIntentId: 'pi_personal',
    stripeCustomerId: 'cus_personal',
    amountMinorUnits: 1900,
    currency: 'usd',
    ownerClassification: 'personal',
    status: 'review_required',
    reason: 'Observation only: canonical personal owner matched; manual review required',
    failureContext: null,
    warningCreatedAt: '2026-05-28T10:00:00.000Z',
    reviewRequiredAt: '2026-05-28T10:00:01.000Z',
    createdAt: '2026-05-28T10:00:01.000Z',
    user: { id: 'user-personal', email: 'personal@example.com', name: 'Personal User' },
    organization: null,
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    stripeEarlyFraudWarningId: 'issfr_organization',
    stripeEventId: 'evt_organization',
    stripeChargeId: null,
    stripePaymentIntentId: null,
    stripeCustomerId: 'cus_organization',
    amountMinorUnits: null,
    currency: null,
    ownerClassification: 'organization',
    status: 'review_required',
    reason: 'Organization-owned warning; manual review required',
    failureContext: null,
    warningCreatedAt: null,
    reviewRequiredAt: '2026-05-28T10:00:01.000Z',
    createdAt: '2026-05-28T10:00:01.000Z',
    user: null,
    organization: { id: 'organization-id', name: 'Review Organization' },
  },
] satisfies EarlyFraudWarningRow[];

describe('EarlyFraudWarningsTable', () => {
  it('renders stored review cases with operational context and safe account links', () => {
    const html = renderToStaticMarkup(
      React.createElement(EarlyFraudWarningsTable, { rows, isLoading: false })
    );

    expect(html).toContain('Personal observation');
    expect(html).toContain('Review required');
    expect(html).toContain('$19.00');
    expect(html).toContain('personal@example.com');
    expect(html).toContain('Review Organization');
    expect(html).toContain('issfr_personal');
    expect(html).toContain('ch_personal');
    expect(html).toContain('payments/ch_personal');
    expect(html).toContain(
      'Observation only: canonical personal owner matched; manual review required'
    );
  });
});
