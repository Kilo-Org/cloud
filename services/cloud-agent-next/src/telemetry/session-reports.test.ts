import { beforeEach, describe, expect, it, vi } from 'vitest';

const reportStore = vi.hoisted(() => ({
  createSessionReport: vi.fn().mockResolvedValue(undefined),
  recordSandboxIdentity: vi.fn().mockResolvedValue({}),
  recordSessionFailure: vi.fn().mockResolvedValue({}),
}));

vi.mock('../db/pg.js', () => ({ getPgDb: vi.fn(() => ({})) }));
vi.mock('./report-store.js', () => ({
  createCloudAgentReportStore: vi.fn(() => reportStore),
}));

import {
  createCloudAgentSessionReport,
  recordCloudAgentSandboxIdentity,
  recordCloudAgentSessionFailure,
} from './session-reports.js';

const env = { HYPERDRIVE: { connectionString: 'postgres://test' } } as never;
const cloudAgentSessionId = 'agent_12345678-1234-1234-1234-123456789abc';

describe('Cloud Agent session report writes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes setup facts through the Cloud Agent report store', async () => {
    await createCloudAgentSessionReport(
      {
        cloudAgentSessionId,
        kiloSessionId: 'ses_12345678901234567890123456',
        initialMessageId: 'msg_initial',
      },
      env
    );
    await recordCloudAgentSandboxIdentity(
      { cloudAgentSessionId, sandboxId: 'ses-sandbox-id' },
      env
    );
    await recordCloudAgentSessionFailure(
      { cloudAgentSessionId, failure: { stage: 'transport', code: 'do_rpc_outcome_unknown' } },
      env
    );

    expect(reportStore.createSessionReport).toHaveBeenCalledWith(
      expect.objectContaining({ occurredAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) })
    );
    expect(reportStore.recordSandboxIdentity).toHaveBeenCalledWith({
      cloudAgentSessionId,
      sandboxId: 'ses-sandbox-id',
    });
    expect(reportStore.recordSessionFailure).toHaveBeenCalledWith(
      expect.objectContaining({ occurredAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) })
    );
  });
});
