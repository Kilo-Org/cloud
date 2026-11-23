import { describe, it, expect } from '@jest/globals';
import {
  BENCHMARK_PLATFORM_PROJECT_ID,
  benchmarkProjectId,
} from '@kilocode/auto-routing-contracts';
import { usageMayAutoTopUp } from './usage-auto-topup-policy';

const ROUTER_ID = '6f1c2f3a-1111-4a2b-8c3d-4e5f60718293';

describe('usageMayAutoTopUp', () => {
  it('never tops up a benchmark case, for either project form', () => {
    expect(
      usageMayAutoTopUp({
        cost: 1234,
        project_id: benchmarkProjectId({ scope: 'user', slug: 'p', routerId: ROUTER_ID }),
      })
    ).toBe(false);
    expect(
      usageMayAutoTopUp({
        cost: 1234,
        project_id: benchmarkProjectId({ scope: 'org', slug: 'p', routerId: ROUTER_ID }),
      })
    ).toBe(false);
    expect(usageMayAutoTopUp({ cost: 1234, project_id: BENCHMARK_PLATFORM_PROJECT_ID })).toBe(
      false
    );
  });

  it('keeps ordinary top-up behavior', () => {
    expect(usageMayAutoTopUp({ cost: 1234, project_id: 'handbook' })).toBe(true);
    expect(usageMayAutoTopUp({ cost: 1234, project_id: null })).toBe(true);
    expect(usageMayAutoTopUp({ cost: 0, project_id: 'handbook' })).toBe(false);
    expect(usageMayAutoTopUp({ cost: 0, project_id: null })).toBe(false);
  });

  it('does not top up a malformed value under the reserved namespace either', () => {
    // Prefix, not strict parse: the row still came from the benchmark path.
    expect(
      usageMayAutoTopUp({ cost: 1, project_id: 'Auto-routing benchmarks / user/Bad/pool/x' })
    ).toBe(false);
    expect(usageMayAutoTopUp({ cost: 1, project_id: 'Auto-routing bench' })).toBe(true);
  });
});
