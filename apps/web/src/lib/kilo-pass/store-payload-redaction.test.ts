import { describe, expect, it } from '@jest/globals';

import { redactStoreAccountLinkedJson } from './store-payload-redaction';

describe('redactStoreAccountLinkedJson', () => {
  it('redacts store account-linked fields recursively', () => {
    expect(
      redactStoreAccountLinkedJson({
        appAccountToken: 'account-token',
        providerTransactionId: 'tx-1',
        nested: {
          purchaseToken: 'purchase-token',
          signedTransactionInfo: 'signed-transaction-info',
          providerSubscriptionId: 'orig-1',
        },
        events: [
          {
            signedPayload: 'signed-payload',
            signedRenewalInfo: 'signed-renewal-info',
          },
        ],
      })
    ).toEqual({
      appAccountToken: null,
      providerTransactionId: 'tx-1',
      nested: {
        purchaseToken: null,
        signedTransactionInfo: null,
        providerSubscriptionId: 'orig-1',
      },
      events: [
        {
          signedPayload: null,
          signedRenewalInfo: null,
        },
      ],
    });
  });

  it('returns an empty object for non-object payloads', () => {
    expect(redactStoreAccountLinkedJson(null)).toEqual({});
    expect(redactStoreAccountLinkedJson('signed-payload')).toEqual({});
    expect(redactStoreAccountLinkedJson(['signed-payload'])).toEqual({});
  });
});
