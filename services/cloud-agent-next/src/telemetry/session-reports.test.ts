import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMetadata } from '../persistence/session-metadata.js';
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
  ensureCloneSessionReport,
  recordCloudAgentSandboxIdentity,
  recordCloudAgentSessionFailure,
} from './session-reports.js';

const env = { HYPERDRIVE: { connectionString: 'postgres://test' } } as never;
const cloudAgentSessionId = 'agent_12345678-1234-1234-1234-123456789abc';
const kiloSessionId = 'ses_12345678901234567890123456';
const cloneFromKiloSessionId = 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa';
const initialMessageId = 'msg_018f1e2d3c4bAbCdEfGhIjKlMn';
const reportingCreatedAt = '2026-08-01T10:00:00.000Z';
const now = Date.parse('2026-08-29T10:00:00.000Z');
const retentionCutoff = now - 90 * 24 * 60 * 60 * 1000;

function cloneMetadata(overrides: Partial<SessionMetadata> = {}): SessionMetadata {
  return {
    metadataSchemaVersion: 2,
    identity: { sessionId: cloudAgentSessionId, userId: 'user_clone' },
    auth: { kiloSessionId },
    clone: { cloneFromKiloSessionId, reportingCreatedAt },
    initialMessage: { id: initialMessageId },
    workspace: { sandboxId: 'usr-123456789abc' },
    lifecycle: { version: now, timestamp: now },
    ...overrides,
  };
}

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

  it('awaits creation for the destination and persisted first message before sandbox identity', async () => {
    const creation = Promise.withResolvers<void>();
    const sandbox = Promise.withResolvers<void>();
    reportStore.createSessionReport.mockReturnValueOnce(creation.promise);
    reportStore.recordSandboxIdentity.mockReturnValueOnce(sandbox.promise);
    let finished = false;
    const write = ensureCloneSessionReport(cloneMetadata(), env).then(() => {
      finished = true;
    });

    expect(reportStore.createSessionReport).toHaveBeenCalledWith({
      cloudAgentSessionId,
      kiloSessionId,
      initialMessageId,
      occurredAt: reportingCreatedAt,
    });
    expect(reportStore.recordSandboxIdentity).not.toHaveBeenCalled();
    creation.resolve();
    await creation.promise;
    await Promise.resolve();
    expect(reportStore.recordSandboxIdentity).toHaveBeenCalledWith({
      cloudAgentSessionId,
      sandboxId: 'usr-123456789abc',
    });
    expect(finished).toBe(false);
    sandbox.resolve();
    await write;
    expect(finished).toBe(true);
  });

  it('retries idempotent creation on later reports without changing clone age', async () => {
    const metadata = cloneMetadata();
    await ensureCloneSessionReport(metadata, env);
    vi.setSystemTime(now + 60_000);
    await ensureCloneSessionReport(metadata, env);

    expect(reportStore.createSessionReport.mock.calls.map(([input]) => input)).toEqual([
      { cloudAgentSessionId, kiloSessionId, initialMessageId, occurredAt: reportingCreatedAt },
      { cloudAgentSessionId, kiloSessionId, initialMessageId, occurredAt: reportingCreatedAt },
    ]);
  });

  it.each([
    { name: 'missing metadata', metadata: null },
    { name: 'unmarked old clone', metadata: cloneMetadata({ clone: { cloneFromKiloSessionId } }) },
    { name: 'non-clone session', metadata: cloneMetadata({ clone: undefined }) },
    { name: 'unadmitted clone', metadata: cloneMetadata({ initialMessage: undefined }) },
    { name: 'missing destination Kilo identity', metadata: cloneMetadata({ auth: {} }) },
    {
      name: 'control-plane session',
      metadata: cloneMetadata({
        identity: {
          sessionId: 'workspace_12345678-1234-1234-1234-123456789abc',
          userId: 'user_clone',
        },
      }),
    },
    ...[0, -1].map(offset => ({
      name: offset === 0 ? 'exactly expired clone' : 'older expired clone',
      metadata: cloneMetadata({
        clone: {
          cloneFromKiloSessionId,
          reportingCreatedAt: new Date(retentionCutoff + offset).toISOString(),
        },
      }),
    })),
  ])('does not create an anchor for $name', async ({ metadata }) => {
    await ensureCloneSessionReport(metadata, env);

    expect(reportStore.createSessionReport).not.toHaveBeenCalled();
    expect(reportStore.recordSandboxIdentity).not.toHaveBeenCalled();
  });

  it('anchors a clone one millisecond inside the reporting retention window', async () => {
    const occurredAt = new Date(retentionCutoff + 1).toISOString();
    await ensureCloneSessionReport(
      cloneMetadata({ clone: { cloneFromKiloSessionId, reportingCreatedAt: occurredAt } }),
      env
    );

    expect(reportStore.createSessionReport).toHaveBeenCalledWith({
      cloudAgentSessionId,
      kiloSessionId,
      initialMessageId,
      occurredAt,
    });
  });

  it.each(['createSessionReport', 'recordSandboxIdentity'] as const)(
    'allows a later report to retry after %s fails',
    async method => {
      reportStore[method].mockRejectedValueOnce(new Error('report storage unavailable'));
      await expect(ensureCloneSessionReport(cloneMetadata(), env)).rejects.toThrow(
        'report storage unavailable'
      );
      await ensureCloneSessionReport(cloneMetadata(), env);

      expect(reportStore.createSessionReport).toHaveBeenCalledTimes(2);
      expect(reportStore.createSessionReport).toHaveBeenLastCalledWith({
        cloudAgentSessionId,
        kiloSessionId,
        initialMessageId,
        occurredAt: reportingCreatedAt,
      });
      expect(reportStore.recordSandboxIdentity).toHaveBeenLastCalledWith({
        cloudAgentSessionId,
        sandboxId: 'usr-123456789abc',
      });
    }
  );
});
