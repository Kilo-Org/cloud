import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type AddCreditsDestination,
  addCreditsDestinationFor,
  addCreditsDestinationOf,
  addCreditsProps,
  organizationBillingUrl,
} from './add-credits-destination';

// The app build bakes the web base URL; the pure project has none.
vi.mock('@/lib/config', () => ({ WEB_BASE_URL: 'https://example.com' }));

const inApp = vi.fn<() => void>();

beforeEach(() => {
  inApp.mockClear();
});

describe('the add credits destination of a balance', () => {
  it('sends an organization’s balance to that organization’s billing page', () => {
    expect(addCreditsDestinationFor('org-a', inApp)).toEqual({
      kind: 'organization',
      url: 'https://example.com/organizations/org-a/payment-details',
    });
    expect(organizationBillingUrl('org-a')).toBe(
      'https://example.com/organizations/org-a/payment-details'
    );
  });

  it('keeps the in-app purchase screen for a person’s own balance', () => {
    expect(addCreditsDestinationFor(undefined, inApp)).toEqual({ kind: 'inApp', onPress: inApp });
  });

  it('offers nothing while the chat’s payer is unresolved', () => {
    expect(addCreditsDestinationOf(null, inApp)).toBeUndefined();
  });

  it('reads the chat’s place as its payer', () => {
    expect(addCreditsDestinationOf({ org: { kind: 'organization', id: 'org-a' } }, inApp)).toEqual({
      kind: 'organization',
      url: 'https://example.com/organizations/org-a/payment-details',
    });
    expect(addCreditsDestinationOf({ org: { kind: 'personal' } }, inApp)).toEqual({
      kind: 'inApp',
      onPress: inApp,
    });
  });
});

describe('the press props of an add credits destination', () => {
  it('hands the element the in-app action or the billing page', () => {
    const inAppDestination: AddCreditsDestination = { kind: 'inApp', onPress: inApp };
    expect(addCreditsProps(inAppDestination)).toEqual({ onPress: inApp });
    expect(addCreditsProps({ kind: 'organization', url: 'https://example.com/pay' })).toEqual({
      url: 'https://example.com/pay',
    });
  });
});
