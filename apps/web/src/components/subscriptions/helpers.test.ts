import {
  getKiloclawDisplayStatus,
  getKiloclawStatusNote,
  isKiloclawPendingSettlement,
} from './helpers';

describe('KiloClaw subscription helpers', () => {
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
