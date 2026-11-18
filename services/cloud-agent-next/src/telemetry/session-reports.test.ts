import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ReportStoreModule from './report-store.js';

const reportStore = vi.hoisted(() => ({
  createSessionReport: vi.fn().mockResolvedValue(undefined),
  recordSandboxIdentity: vi.fn().mockResolvedValue({}),
  recordSessionFailure: vi.fn().mockResolvedValue({}),
}));

vi.mock('../db/pg.js', () => ({ getPgDb: vi.fn(() => ({})) }));
vi.mock('./report-store.js', async importOriginal => ({
  ...(await importOriginal<typeof ReportStoreModule>()),
  createCloudAgentReportStore: vi.fn(() => reportStore),
}));

import {
  createCloudAgentSessionReport,
  recordCloudAgentSandboxIdentity,
  recordCloudAgentSessionFailure,
} from './session-reports.js';

const env = { HYPERDRIVE: { connectionString: 'postgres://test' } } as never;
const cloudAgentSessionId = 'workspace_12345678-1234-4234-9234-123456789abc';
const kiloSessionId = 'ses_12345678901234567890123456';
const initialMessageId = 'msg_018f1e2d3c4bAbCdEfGhIjKlMn';
const reportingCreatedAt = '2026-08-01T10:00:00.000Z';
const now = Date.parse('2026-08-29T10:00:00.000Z');

describe('Cloud Agent session report writes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reportStore.createSessionReport.mockResolvedValue(undefined);
    reportStore.recordSandboxIdentity.mockResolvedValue({});
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes setup facts through the Cloud Agent report store', async () => {
    await createCloudAgentSessionReport(
      { cloudAgentSessionId, kiloSessionId, initialMessageId },
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

    expect(reportStore.createSessionReport).toHaveBeenCalledWith({
      cloudAgentSessionId,
      kiloSessionId,
      initialMessageId,
      occurredAt: new Date(now).toISOString(),
    });
    expect(reportStore.recordSandboxIdentity).toHaveBeenCalledWith({
      cloudAgentSessionId,
      sandboxId: 'ses-sandbox-id',
    });
    expect(reportStore.recordSessionFailure).toHaveBeenCalledWith(
      expect.objectContaining({ occurredAt: new Date(now).toISOString() })
    );
  });

  it('preserves an explicit reporting creation time instead of using report delivery time', async () => {
    await createCloudAgentSessionReport(
      { cloudAgentSessionId, kiloSessionId, initialMessageId, occurredAt: reportingCreatedAt },
      env
    );

    expect(reportStore.createSessionReport).toHaveBeenCalledWith({
      cloudAgentSessionId,
      kiloSessionId,
      initialMessageId,
      occurredAt: reportingCreatedAt,
    });
  });
});
