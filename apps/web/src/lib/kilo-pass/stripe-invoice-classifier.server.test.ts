import { describe, expect, test } from '@jest/globals';
import { invoiceLooksLikeOrganizationKiloPass } from './stripe-invoice-classifier.server';

describe('organization Kilo Pass invoice classifier', () => {
  test('classifies explicit organization metadata before shared personal price fallback', () => {
    const invoice = {
      parent: {
        subscription_details: {
          metadata: {
            type: 'kilo-pass-org',
            organizationId: 'org_123',
            kiloUserId: 'user_123',
            tier: 'tier_19',
            cadence: 'monthly',
          },
        },
      },
    };
    expect(invoiceLooksLikeOrganizationKiloPass(invoice as never)).toBe(true);
  });
});
