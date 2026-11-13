import { describe, expect, it } from 'vitest';

import {
  isStoreManagedPass,
  selectKiloPassManagementAction,
  storeSubscriptionsUrl,
} from './management';

describe('selectKiloPassManagementAction', () => {
  const base = { paymentProvider: 'stripe', status: 'active', cancelAtPeriodEnd: false };

  it('offers cancellation for an active pass', () => {
    expect(selectKiloPassManagementAction(base)).toBe('cancel');
  });

  it('offers a resume for a pass that is already ending', () => {
    expect(selectKiloPassManagementAction({ ...base, cancelAtPeriodEnd: true })).toBe(
      'resume-cancelled'
    );
  });

  it('offers a resume for a paused pass, ahead of any cancellation', () => {
    expect(
      selectKiloPassManagementAction({
        ...base,
        status: 'paused',
        cancelAtPeriodEnd: true,
      })
    ).toBe('resume-paused');
  });

  it.each(['canceled', 'incomplete_expired', 'unpaid'])(
    'offers nothing for a pass the provider ended (%s)',
    status => {
      expect(selectKiloPassManagementAction({ ...base, status })).toBe('none');
    }
  );

  it.each(['trialing', 'past_due', 'incomplete'])(
    'offers nothing for the %s state, which the console resolves first',
    status => {
      expect(selectKiloPassManagementAction({ ...base, status })).toBe('none');
    }
  );

  it.each(['app_store', 'google_play'])(
    'offers no Stripe action for a pass the store sold (%s)',
    paymentProvider => {
      expect(selectKiloPassManagementAction({ ...base, paymentProvider })).toBe('none');
    }
  );
});

describe('isStoreManagedPass', () => {
  it('treats every non-Stripe provider as store-managed', () => {
    expect(isStoreManagedPass({ paymentProvider: 'stripe' })).toBe(false);
    expect(isStoreManagedPass({ paymentProvider: 'app_store' })).toBe(true);
    expect(isStoreManagedPass({ paymentProvider: 'google_play' })).toBe(true);
  });
});

describe('storeSubscriptionsUrl', () => {
  it('points each store at its own subscription settings', () => {
    expect(storeSubscriptionsUrl('app_store')).toContain('apps.apple.com');
    expect(storeSubscriptionsUrl('google_play')).toContain('play.google.com');
  });
});
