import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db/pg.js', () => ({
  getPgDb: vi.fn(() => ({})),
}));

vi.mock('./report-store.js', () => ({
  createCloudAgentReportStore: vi.fn(),
}));

import { createCloudAgentReportStore } from './report-store.js';
import { CLOUD_AGENT_REPORT_QUEUE_NAMES, consumeCloudAgentReportBatch } from './report-consumer.js';

const report = {
  version: 1,
  type: 'run.state',
  occurredAt: '2026-05-26T08:00:00.000Z',
  session: { cloudAgentSessionId: 'agent_12345678-1234-4234-8234-123456789abc' },
  run: {
    messageId: 'msg_1',
    status: 'failed',
    terminalAt: '2026-05-26T08:04:00.000Z',
    failureStage: 'unknown',
    failureCode: 'unclassified',
  },
} as const;

function makeMessage(body: unknown) {
  return { body, ack: vi.fn(), retry: vi.fn() };
}

const env = {
  HYPERDRIVE: { connectionString: 'postgres://test' },
} as never;

describe('Cloud Agent report consumer', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('routes isolated development reporting queue messages', () => {
    expect(CLOUD_AGENT_REPORT_QUEUE_NAMES.has('cloud-agent-next-report-queue-dev')).toBe(true);
  });

  it('acks a valid saved report after its essential write completes', async () => {
    const saveReport = vi.fn(async () => ({ outcome: 'applied' as const }));
    vi.mocked(createCloudAgentReportStore).mockReturnValue({ saveReport } as never);
    const message = makeMessage(report);

    await consumeCloudAgentReportBatch(
      { messages: [message] } as unknown as MessageBatch<unknown>,
      env
    );

    expect(saveReport).toHaveBeenCalledWith(report);
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('acks an expired saved report', async () => {
    const saveReport = vi.fn().mockResolvedValueOnce({ outcome: 'expired' });
    vi.mocked(createCloudAgentReportStore).mockReturnValue({ saveReport } as never);
    const expired = makeMessage(report);

    await consumeCloudAgentReportBatch(
      { messages: [expired] } as unknown as MessageBatch<unknown>,
      env
    );

    expect(expired.ack).toHaveBeenCalledOnce();
  });

  it('logs and acknowledges reports whose session anchor is absent', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const saveReport = vi.fn().mockResolvedValueOnce({ outcome: 'missing_parent' });
    vi.mocked(createCloudAgentReportStore).mockReturnValue({ saveReport } as never);
    const message = makeMessage(report);

    await consumeCloudAgentReportBatch(
      { messages: [message] } as unknown as MessageBatch<unknown>,
      env
    );

    expect(warn).toHaveBeenCalledWith('Dropping Cloud Agent run report without a session anchor', {
      cloudAgentSessionId: report.session.cloudAgentSessionId,
    });
    expect(message.ack).toHaveBeenCalledOnce();
  });

  it('drops malformed messages without logging their body', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const saveReport = vi.fn();
    vi.mocked(createCloudAgentReportStore).mockReturnValue({ saveReport } as never);
    const message = makeMessage({ diagnostic: 'secret payload' });

    await consumeCloudAgentReportBatch(
      { messages: [message] } as unknown as MessageBatch<unknown>,
      env
    );

    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(saveReport).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('Dropping malformed Cloud Agent report message', {
      issueCount: expect.any(Number),
    });
  });

  it('discards an invalid optional diagnostic while saving a typed failed outcome', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const saveReport = vi.fn(async () => ({ outcome: 'applied' as const }));
    vi.mocked(createCloudAgentReportStore).mockReturnValue({ saveReport } as never);
    const message = makeMessage({
      ...report,
      run: {
        ...report.run,
        diagnostic: {
          errorMessageRedacted: 'too late but not saved',
          errorExpiresAt: report.run.terminalAt,
        },
      },
    });

    await consumeCloudAgentReportBatch(
      { messages: [message] } as unknown as MessageBatch<unknown>,
      env
    );

    expect(saveReport).toHaveBeenCalledWith(report);
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('retries transient report save failures', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(createCloudAgentReportStore).mockReturnValue({
      saveReport: vi.fn(async () => {
        throw new Error('database unavailable');
      }),
    } as never);
    const message = makeMessage(report);

    await consumeCloudAgentReportBatch(
      { messages: [message] } as unknown as MessageBatch<unknown>,
      env
    );

    expect(message.retry).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
  });
});
