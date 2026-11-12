import { describe, expect, it } from 'vitest';

import {
  computeChargesMicrodollars,
  isCloudAgentSessionId,
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
