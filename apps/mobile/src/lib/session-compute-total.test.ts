import { describe, expect, it } from 'vitest';

import {
  computeChargesMicrodollars,
  computeChargesRefetchInterval,
  computeHourlyUsdFromCentsPerSecond,
  isCloudAgentSessionId,
  SESSION_COMPUTE_POLL_MS,
  type SessionComputeCharges,
  sessionTotalMicrodollars,
} from './session-compute-total';

const CLOUD_SESSION_ID = 'workspace_5c1a3f0e-2b7d-4c9a-8f6e-1d2b3c4d5e6f';

describe('isCloudAgentSessionId', () => {
  it('accepts a Cloud Agent id', () => {
    expect(isCloudAgentSessionId(CLOUD_SESSION_ID)).toBe(true);
  });

  it('rejects a session id the compute routers refuse', () => {
    expect(isCloudAgentSessionId('agent_5c1a3f0e-2b7d-4c9a-8f6e-1d2b3c4d5e6f')).toBe(false);
    expect(isCloudAgentSessionId('ses_123')).toBe(false);
    expect(isCloudAgentSessionId('')).toBe(false);
    expect(isCloudAgentSessionId(null)).toBe(false);
    expect(isCloudAgentSessionId(undefined)).toBe(false);
  });
});

describe('computeChargesMicrodollars', () => {
  it('returns the recorded amount', () => {
    expect(computeChargesMicrodollars({ amountMicrodollars: 4250 })).toBe(4250);
  });

  it('keeps zero as a recorded amount', () => {
    expect(computeChargesMicrodollars({ amountMicrodollars: 0 })).toBe(0);
  });

  it('reports nothing for an unsettled or malformed read', () => {
    expect(computeChargesMicrodollars(undefined)).toBeNull();
    expect(computeChargesMicrodollars({ amountMicrodollars: Number.NaN })).toBeNull();
  });
});

describe('sessionTotalMicrodollars', () => {
  it('adds model and compute cost', () => {
    expect(sessionTotalMicrodollars(31_200, 4_500)).toBe(35_700);
  });

  it('keeps the model cost when compute is unknown', () => {
    expect(sessionTotalMicrodollars(31_200, null)).toBe(31_200);
  });

  it('keeps the compute cost when the model cost is unknown', () => {
    expect(sessionTotalMicrodollars(null, 4_500)).toBe(4_500);
  });

  it('paints no total when neither is known', () => {
    expect(sessionTotalMicrodollars(null, null)).toBeNull();
  });
});

describe('computeHourlyUsdFromCentsPerSecond', () => {
  it('converts cents per second to dollars per hour', () => {
    // $0.60 for a five-minute run is $7.20/hour.
    expect(computeHourlyUsdFromCentsPerSecond(0.2)).toBeCloseTo(7.2, 10);
  });

  it('agrees with the catalogue rate the sheet prints', () => {
    // The server multiplies the same column by 36 for its hourly catalogue.
    expect(computeHourlyUsdFromCentsPerSecond(0.001)).toBeCloseTo(0.036, 10);
  });
});

describe('computeChargesRefetchInterval', () => {
  const withRuns = (open: boolean[]): Pick<SessionComputeCharges, 'runs'> => ({
    runs: open.map(running => ({
      startedAt: '2026-11-12T10:00:00.000Z',
      stoppedAt: running ? null : '2026-11-12T10:01:00.000Z',
      running,
      instance: 'standard-3',
      rateCentsPerSecond: 0.2,
      seconds: 60,
      amountMicrodollars: 500_000,
    })),
  });

  it('polls while a run is still open, so a stopped run cannot stay running', () => {
    expect(computeChargesRefetchInterval(withRuns([false, true]))).toBe(SESSION_COMPUTE_POLL_MS);
  });

  it('stops polling once every run has stopped', () => {
    expect(computeChargesRefetchInterval(withRuns([false]))).toBe(false);
    expect(computeChargesRefetchInterval(withRuns([]))).toBe(false);
  });

  it('does not poll before the first read arrives', () => {
    expect(computeChargesRefetchInterval(undefined)).toBe(false);
  });
});
