import {
  formatCodingPlanBillingAmount,
  formatCodingPlanPrice,
  formatLocalDateTimeLabel,
  formatKiloclawPrice,
  formatPaymentSummary,
  getCodingPlanBillingDate,
  getCodingPlanDisplayStatus,
  getKiloclawDisplayStatus,
  getKiloclawStatusNote,
  isCodingPlanTerminal,
  isKiloclawPendingSettlement,
} from './helpers';

describe('Coding Plan subscription helpers', () => {
  const activeSubscription = {
    status: 'active',
    cancelAtPeriodEnd: false,
    currentPeriodEnd: '2026-06-26T08:00:00.000Z',
    creditRenewalAt: '2026-06-26T08:00:00.000Z',
    paymentGraceExpiresAt: null,
    canceledAt: null,
  };

  it('formats prices and billing charges in USD', () => {
    expect(formatCodingPlanPrice(20, 30, 'minimax-token-plan-plus')).toBe('$20 /month');
    expect(formatCodingPlanPrice(20, 30)).toBe('$20 / 30 days');
    expect(formatCodingPlanPrice(12.5, 14)).toBe('$12.50 / 14 days');
    expect(formatCodingPlanBillingAmount(20_000_000)).toBe('$20');
    expect(formatCodingPlanBillingAmount(-20_000_000)).toBe('$20');
    expect(formatCodingPlanBillingAmount(12_500_000)).toBe('$12.50');
  });

  it('displays scheduled cancellations as access ending at paid-period end', () => {
    expect(getCodingPlanDisplayStatus({ ...activeSubscription, cancelAtPeriodEnd: true })).toBe(
      'pending_cancellation'
    );
    expect(getCodingPlanBillingDate({ ...activeSubscription, cancelAtPeriodEnd: true })).toEqual({
      label: 'Access ends',
      date: activeSubscription.currentPeriodEnd,
    });
  });

  it('displays past-due grace deadlines and canceled terminal state', () => {
    expect(
      getCodingPlanBillingDate({
        ...activeSubscription,
        status: 'past_due',
        paymentGraceExpiresAt: '2026-05-27T08:00:00.000Z',
      })
    ).toEqual({ label: 'Grace expires', date: '2026-05-27T08:00:00.000Z' });
    expect(
      getCodingPlanBillingDate({
        ...activeSubscription,
        status: 'canceled',
        canceledAt: '2026-05-27T08:00:00.000Z',
      })
    ).toEqual({ label: 'Ended at', date: '2026-05-27T08:00:00.000Z' });
    expect(isCodingPlanTerminal('canceled')).toBe(true);
    expect(isCodingPlanTerminal('active')).toBe(false);
  });

  it('includes local date and time for payment grace deadlines', () => {
    const deadline = '2026-05-27T08:00:00.000Z';
    expect(formatLocalDateTimeLabel(deadline)).toBe(
      new Date(deadline).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    );
  });
});

describe('KiloClaw subscription helpers', () => {
  it('formats KiloClaw prices from subscription row price versions', () => {
    expect(formatKiloclawPrice({ plan: 'standard', priceVersion: '2026-03-19' })).toBe('$9/month');
    expect(formatKiloclawPrice({ plan: 'commit', priceVersion: '2026-03-19' })).toBe(
      '$48/6-month commit'
    );
    expect(formatKiloclawPrice({ plan: 'standard', priceVersion: '2026-05-10' })).toBe('$55/month');
    expect(formatKiloclawPrice({ plan: 'commit', priceVersion: '2026-05-10' })).toBe(
      '$306/6-month commit'
    );
  });

  it('labels Stripe-funded hybrid subscriptions as Stripe', () => {
    expect(
      formatPaymentSummary({
        paymentSource: 'stripe',
        hasStripeFunding: true,
      })
    ).toBe('Stripe');
    expect(
      formatPaymentSummary({
        paymentSource: 'credits',
        hasStripeFunding: true,
      })
    ).toBe('Stripe');
    expect(
      formatPaymentSummary({
        paymentSource: 'credits',
        hasStripeFunding: false,
      })
    ).toBe('Credits');
  });

  it('marks pending settlement rows explicitly for display', () => {
    expect(
      getKiloclawDisplayStatus({
        status: 'active',
        activationState: 'pending_settlement',
      })
    ).toBe('pending_settlement');
    expect(
      getKiloclawStatusNote({
        activationState: 'pending_settlement',
      })
    ).toBe('Payment processing. Hosting activates after invoice settlement.');
    expect(
      isKiloclawPendingSettlement({
        activationState: 'pending_settlement',
      })
    ).toBe(true);
  });

  it('preserves activated rows', () => {
    expect(
      getKiloclawDisplayStatus({
        status: 'active',
        activationState: 'activated',
      })
    ).toBe('active');
    expect(
      getKiloclawStatusNote({
        activationState: 'activated',
      })
    ).toBeNull();
    expect(
      isKiloclawPendingSettlement({
        activationState: 'activated',
      })
    ).toBe(false);
  });

  it('does not mask failed Stripe-backed rows once activation has fallen back to activated', () => {
    expect(
      getKiloclawDisplayStatus({
        status: 'unpaid',
        activationState: 'activated',
      })
    ).toBe('unpaid');
    expect(
      getKiloclawDisplayStatus({
        status: 'canceled',
        activationState: 'activated',
      })
    ).toBe('canceled');
    expect(
      getKiloclawStatusNote({
        activationState: 'activated',
      })
    ).toBeNull();
  });
});
