import { describe, it, expect } from '@jest/globals';
import { benchmarkPayerRefusal, gatewayBalanceRead } from './benchmark-balance-policy';

describe('gatewayBalanceRead', () => {
  it('reads the primary and skips top-up for a benchmark case', () => {
    expect(gatewayBalanceRead({ isFreeModel: false, benchmark: true })).toEqual({
      fresh: true,
      fundUsage: false,
    });
  });

  it('keeps replica plus usage-funded top-up for an ordinary paid request', () => {
    expect(gatewayBalanceRead({ isFreeModel: false, benchmark: false })).toEqual({
      fresh: false,
      fundUsage: true,
    });
  });

  it('never funds a free model, and reads the replica when it is not a benchmark', () => {
    expect(gatewayBalanceRead({ isFreeModel: true, benchmark: false })).toEqual({
      fresh: false,
      fundUsage: false,
    });
    expect(gatewayBalanceRead({ isFreeModel: true, benchmark: true })).toEqual({
      fresh: true,
      fundUsage: false,
    });
  });
});

describe('benchmarkPayerRefusal', () => {
  it('tags only a real credit refusal as payment_refused', () => {
    expect(
      benchmarkPayerRefusal({ creditsBlocked: true, payerResolved: true, membershipUsable: true })
    ).toBe('payment_refused');
  });

  it('treats an unresolved identity as payer_unavailable, never a payment refusal', () => {
    expect(
      benchmarkPayerRefusal({ creditsBlocked: true, payerResolved: false, membershipUsable: true })
    ).toBe('payer_unavailable');
    expect(
      benchmarkPayerRefusal({
        creditsBlocked: true,
        payerResolved: true,
        membershipUsable: false,
      })
    ).toBe('payer_unavailable');
  });

  it('admits a funded, resolved payer', () => {
    expect(
      benchmarkPayerRefusal({ creditsBlocked: false, payerResolved: true, membershipUsable: true })
    ).toBeNull();
  });
});
