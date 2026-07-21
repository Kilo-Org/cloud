import { describe, expect, it } from '@jest/globals';
import { healthErrorSessionsInput } from './health-query-input';

describe('healthErrorSessionsInput', () => {
  it('keeps the exact aggregated responsibility and reason in drill-down input', () => {
    expect(
      healthErrorSessionsInput(
        { startDate: '2026-07-20T00:00:00.000Z', endDate: '2026-07-21T00:00:00.000Z' },
        {
          source: 'run',
          stage: 'agent_activity',
          code: 'assistant_error',
          responsibility: 'platform',
          reason: 'managed_provider_unavailable',
        }
      )
    ).toEqual({
      startDate: '2026-07-20T00:00:00.000Z',
      endDate: '2026-07-21T00:00:00.000Z',
      source: 'run',
      stage: 'agent_activity',
      code: 'assistant_error',
      responsibility: 'platform',
      reason: 'managed_provider_unavailable',
    });
  });
});
