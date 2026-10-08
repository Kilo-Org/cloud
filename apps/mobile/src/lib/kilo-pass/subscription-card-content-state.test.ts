import { describe, expect, it } from 'vitest';
import { KILO_PASS_MANAGE_CTA_LABEL, KILO_PASS_TITLE } from '@kilocode/app-shared/commerce';
import { getKiloPassSubscriptionCardContentState } from './subscription-card-state';

describe('getKiloPassSubscriptionCardContentState', () => {
  it('keeps pending presentation non-actionable while loading', () => {
    expect(
      getKiloPassSubscriptionCardContentState({
        presentation: undefined,
        presentationIsError: false,
        presentationIsPending: true,
      })
    ).toEqual({ kind: 'loading' });
  });

  it('keeps presentation errors on retry', () => {
    expect(
      getKiloPassSubscriptionCardContentState({
        presentation: undefined,
        presentationIsError: true,
        presentationIsPending: false,
      })
    ).toEqual({
      actionLabel: 'Retry',
      description: 'Try again from Profile.',
      kind: 'error',
      title: 'Kilo Pass unavailable',
    });
  });

  it('keeps a missing presentation loading', () => {
    expect(
      getKiloPassSubscriptionCardContentState({
        presentation: undefined,
        presentationIsError: false,
        presentationIsPending: false,
      })
    ).toEqual({ kind: 'loading' });
  });

  it('renders the unavailable surface without a purchase CTA', () => {
    expect(
      getKiloPassSubscriptionCardContentState({
        presentation: { kind: 'unavailable' },
        presentationIsError: false,
        presentationIsPending: false,
      })
    ).toEqual({
      kind: 'card',
      state: {
        action: 'open-native',
        actionLabel: null,
        description: 'Kilo Pass purchase is not available right now.',
        title: KILO_PASS_TITLE,
      },
    });
  });

  it('renders the web-management surface with a Manage action', () => {
    expect(
      getKiloPassSubscriptionCardContentState({
        presentation: { kind: 'web_management' },
        presentationIsError: false,
        presentationIsPending: false,
      })
    ).toEqual({
      kind: 'card',
      state: {
        action: 'open-web',
        actionLabel: KILO_PASS_MANAGE_CTA_LABEL,
        description: 'This Kilo Pass is managed on web',
        title: KILO_PASS_TITLE,
      },
    });
  });
});
