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

const diagnostic = {
  errorMessageRedacted: 'The model provider is unavailable',
  errorExpiresAt: '2026-06-25T08:04:00.000Z',
};
const retiredFacts = { version: 1, sdkStatusCode: 503 };

function makeMessage(body: unknown, attempts = 1) {
  return { body, attempts, ack: vi.fn(), retry: vi.fn() };
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

  it('acks an expired saved report after discarding retired diagnostic data', async () => {
    const saveReport = vi.fn().mockResolvedValueOnce({ outcome: 'expired' });
    vi.mocked(createCloudAgentReportStore).mockReturnValue({ saveReport } as never);
    const expired = makeMessage({
      ...report,
      run: { ...report.run, diagnostic: { ...diagnostic, facts: retiredFacts } },
    });

    await consumeCloudAgentReportBatch(
      { messages: [expired] } as unknown as MessageBatch<unknown>,
      env
    );

    expect(saveReport).toHaveBeenCalledExactlyOnceWith({
      ...report,
      run: { ...report.run, diagnostic },
    });
    expect(expired.ack).toHaveBeenCalledOnce();
    expect(expired.retry).not.toHaveBeenCalled();
  });

  it.each([1, 4])(
    'retries missing parents on delivery attempt %s using the queue policy',
    async attempt => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const saveReport = vi.fn().mockResolvedValueOnce({ outcome: 'missing_parent' });
      vi.mocked(createCloudAgentReportStore).mockReturnValue({ saveReport } as never);
      const message = makeMessage({ ...report, run: { ...report.run, diagnostic } }, attempt);

      await consumeCloudAgentReportBatch(
        { messages: [message] } as unknown as MessageBatch<unknown>,
        env
      );

      expect(warn).toHaveBeenCalledExactlyOnceWith(
        'Retrying Cloud Agent run report without a session anchor',
        {
          cloudAgentSessionId: report.session.cloudAgentSessionId,
          messageId: report.run.messageId,
          status: report.run.status,
          attempt,
        }
      );
      expect(message.retry).toHaveBeenCalledExactlyOnceWith();
      expect(message.ack).not.toHaveBeenCalled();
    }
  );

  it('continues the batch after a missing parent and acknowledges a later successful redelivery', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const saveReport = vi
      .fn()
      .mockResolvedValueOnce({ outcome: 'missing_parent' })
      .mockResolvedValueOnce({ outcome: 'applied' })
      .mockResolvedValueOnce({ outcome: 'expired' })
      .mockResolvedValueOnce({ outcome: 'applied' });
    vi.mocked(createCloudAgentReportStore).mockReturnValue({ saveReport } as never);
    const missing = makeMessage(report);
    const applied = makeMessage(report);
    const expired = makeMessage(report);
    const malformed = makeMessage({ version: 99 });

    await consumeCloudAgentReportBatch(
      { messages: [missing, applied, expired, malformed] } as unknown as MessageBatch<unknown>,
      env
    );

    expect(missing.retry).toHaveBeenCalledOnce();
    expect(missing.ack).not.toHaveBeenCalled();
    for (const message of [applied, expired, malformed]) {
      expect(message.ack).toHaveBeenCalledOnce();
      expect(message.retry).not.toHaveBeenCalled();
    }
    const redelivery = makeMessage(report, 2);
    await consumeCloudAgentReportBatch(
      { messages: [redelivery] } as unknown as MessageBatch<unknown>,
      env
    );
    expect(redelivery.ack).toHaveBeenCalledOnce();
    expect(redelivery.retry).not.toHaveBeenCalled();
    expect(saveReport).toHaveBeenCalledTimes(4);
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

  it.each([
    { name: 'current', diagnostic },
    { name: 'older', diagnostic: { ...diagnostic, facts: retiredFacts } },
    {
      name: 'opaque retired data',
      diagnostic: { ...diagnostic, facts: 'discarded fixture payload' },
    },
    { name: 'null retired data', diagnostic: { ...diagnostic, facts: null } },
  ])(
    'preserves safe diagnostic text and typed outcomes for $name reports without retaining retired data',
    async ({ diagnostic: incomingDiagnostic }) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const saveReport = vi.fn(async () => ({ outcome: 'applied' as const }));
      vi.mocked(createCloudAgentReportStore).mockReturnValue({ saveReport } as never);
      const message = makeMessage({
        ...report,
        run: { ...report.run, diagnostic: incomingDiagnostic },
      });

      await consumeCloudAgentReportBatch(
        { messages: [message] } as unknown as MessageBatch<unknown>,
        env
      );

      expect(saveReport).toHaveBeenCalledExactlyOnceWith({
        ...report,
        run: { ...report.run, diagnostic },
      });
      expect(warn).not.toHaveBeenCalled();
      expect(message.ack).toHaveBeenCalledOnce();
      expect(message.retry).not.toHaveBeenCalled();
    }
  );

  it.each([
    { errorMessageRedacted: '' },
    { errorMessageRedacted: 'm'.repeat(4097) },
    { errorExpiresAt: 'invalid timestamp' },
    { errorExpiresAt: report.run.terminalAt },
    { errorExpiresAt: '2026-06-26T08:04:00.000Z' },
    { responseBody: 'private fixture output' },
  ])(
    'retains whole-diagnostic fallback for invalid message, expiry, or unknown content: %j',
    async invalidDiagnostic => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const saveReport = vi.fn(async () => ({ outcome: 'applied' as const }));
      vi.mocked(createCloudAgentReportStore).mockReturnValue({ saveReport } as never);
      const message = makeMessage({
        ...report,
        run: {
          ...report.run,
          diagnostic: { ...diagnostic, facts: retiredFacts, ...invalidDiagnostic },
        },
      });

      await consumeCloudAgentReportBatch(
        { messages: [message] } as unknown as MessageBatch<unknown>,
        env
      );

      expect(saveReport).toHaveBeenCalledExactlyOnceWith(report);
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        'Dropping invalid Cloud Agent report diagnostic'
      );
      expect(message.ack).toHaveBeenCalledOnce();
      expect(message.retry).not.toHaveBeenCalled();
    }
  );

  it.each([
    {
      name: 'missing terminal time',
      body: { ...report, run: { ...report.run, terminalAt: undefined } },
    },
    {
      name: 'invalid classification',
      body: {
        ...report,
        run: { ...report.run, failureStage: 'pre_dispatch', failureCode: 'assistant_error' },
      },
    },
    { name: 'unknown envelope field', body: { ...report, metadata: 'private fixture' } },
    {
      name: 'unknown session field',
      body: { ...report, session: { ...report.session, metadata: 'private fixture' } },
    },
    {
      name: 'unknown run field',
      body: { ...report, run: { ...report.run, metadata: 'private fixture' } },
    },
  ])('rejects $name even with retired diagnostic data', async ({ body }) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const saveReport = vi.fn();
    vi.mocked(createCloudAgentReportStore).mockReturnValue({ saveReport } as never);
    const message = makeMessage({
      ...body,
      run: { ...body.run, diagnostic: { ...diagnostic, facts: retiredFacts } },
    });

    await consumeCloudAgentReportBatch(
      { messages: [message] } as unknown as MessageBatch<unknown>,
      env
    );

    expect(saveReport).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledExactlyOnceWith('Dropping malformed Cloud Agent report message', {
      issueCount: expect.any(Number),
    });
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
