import type { CustomerInfo } from '@/lib/customerInfo';
import { created_before } from './promoCustomerRequirement';

function makeCustomerInfo(overrides: { created_at: string }): CustomerInfo {
  return {
    user: { created_at: overrides.created_at } as CustomerInfo['user'],
  } as CustomerInfo;
}

describe('created_before', () => {
  const cutoff = new Date('2026-04-11');
  const requirement = created_before(cutoff);

  it('succeeds when user was created before the cutoff', () => {
    const result = requirement(makeCustomerInfo({ created_at: '2026-04-10T23:59:59Z' }));
    expect(result.success).toBe(true);
  });

  it('succeeds when user was created well before the cutoff', () => {
    const result = requirement(makeCustomerInfo({ created_at: '2025-01-01T00:00:00Z' }));
    expect(result.success).toBe(true);
  });

  it('fails when user was created exactly at the cutoff', () => {
    const result = requirement(makeCustomerInfo({ created_at: '2026-04-11T00:00:00Z' }));
    expect(result.success).toBe(false);
  });

  it('fails when user was created after the cutoff', () => {
    const result = requirement(makeCustomerInfo({ created_at: '2026-04-12T00:00:00Z' }));
    expect(result.success).toBe(false);
  });

  it('returns a descriptive error message on failure', () => {
    const result = requirement(makeCustomerInfo({ created_at: '2026-04-11T00:00:00Z' }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('eligibility cutoff');
    }
  });
});
