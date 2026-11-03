import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { after } from 'next/server';
import {
  recordEnkryptUsage,
  type EnkryptGuardrailCall,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/usage';
import {
  scanRequest,
  type EnkryptGuardrailScan,
  type EnkryptGuardrailScanResult,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/detect';
import type { EnkryptDetectRequestDetectors } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/detectors';
import { startEnkryptInputGuardrail } from './input-guardrail';

jest.mock('next/server', () => ({
  ...jest.requireActual<Record<string, unknown>>('next/server'),
  after: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/usage', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/usage'
  ),
  recordEnkryptUsage: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/detect', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/detect'
  ),
  scanRequest: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  ENKRYPT_API_KEY: 'test-enkrypt-key',
}));

const mockedAfter = jest.mocked(after);
const mockedRecordUsage = jest.mocked(recordEnkryptUsage);
const mockedScanRequest = jest.mocked(scanRequest);
const signal = new AbortController().signal;

const detectors = {
  injection_attack: { enabled: true, need_explanation: false },
  pii: { enabled: true, entities: ['secrets'] },
} satisfies EnkryptDetectRequestDetectors;

const scan: EnkryptGuardrailScan = {
  sessionId: 'ses_guardrail',
  organizationId: '00000000-0000-4000-8000-000000000002',
  kiloUserId: 'oauth/google:123',
  apiKind: 'messages',
  clientRequestId: null,
  text: 'tool output',
  config: {
    scanToolResults: true,
    status: 'ready',
    detectors: { injection_attack: detectors.injection_attack },
    blockingDetectors: ['injection_attack'],
  },
};

const mixedScan: EnkryptGuardrailScan = {
  ...scan,
  config: {
    scanToolResults: true,
    status: 'ready',
    detectors,
    blockingDetectors: ['injection_attack'],
  },
};

const logOnlyScan: EnkryptGuardrailScan = {
  ...scan,
  config: {
    scanToolResults: true,
    status: 'ready',
    detectors: { pii: detectors.pii },
    blockingDetectors: [],
  },
};

function isLogOnly({ config }: EnkryptGuardrailScan) {
  return config.status === 'ready' && config.blockingDetectors.length === 0;
}

function call(overrides: Partial<EnkryptGuardrailCall> = {}): EnkryptGuardrailCall {
  return {
    organizationId: scan.organizationId,
    kiloUserId: scan.kiloUserId,
    sessionId: scan.sessionId,
    apiKind: scan.apiKind,
    decision: 'allowed',
    creditsCost: 3,
    ...overrides,
  };
}

async function runAfterTasks() {
  await Promise.all(mockedAfter.mock.calls.map(([task]) => (task as () => Promise<void>)()));
}

beforeEach(() => {
  mockedAfter.mockReset();
  mockedRecordUsage.mockReset().mockResolvedValue(undefined);
  mockedScanRequest.mockReset();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('startEnkryptInputGuardrail', () => {
  it.each(['preparation', 'detection'])(
    'fails closed when scan %s throws unexpectedly',
    async stage => {
      jest.spyOn(console, 'error').mockImplementation(() => {});
      const error = new RangeError('Maximum call stack size exceeded');
      mockedScanRequest.mockRejectedValue(error);

      const guardrail = startEnkryptInputGuardrail(
        stage === 'preparation' ? Promise.reject(error) : Promise.resolve(scan),
        signal
      );

      expect(await guardrail.awaitVerdict()).toEqual({ action: 'unavailable', reason: 'failed' });
      await runAfterTasks();
      expect(mockedRecordUsage).not.toHaveBeenCalled();
    }
  );

  it('starts the request scan with a 30-second timeout', async () => {
    mockedScanRequest.mockResolvedValue({ verdict: { action: 'allow' }, usageRecords: [] });

    const guardrail = startEnkryptInputGuardrail(Promise.resolve(scan), signal);
    await guardrail.awaitVerdict();

    expect(mockedScanRequest).toHaveBeenCalledWith(
      scan,
      expect.objectContaining({ timeoutMs: 30_000, signal })
    );
  });

  it('records the wait for the verdict on the final call of the request only', async () => {
    const result: EnkryptGuardrailScanResult = {
      verdict: { action: 'allow' },
      usageRecords: [call({ decision: 'error', creditsCost: null }), call()],
    };
    mockedScanRequest.mockResolvedValue(result);
    jest.spyOn(performance, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(1_237.4);

    const guardrail = startEnkryptInputGuardrail(Promise.resolve(scan), signal);
    expect(await guardrail.awaitVerdict()).toEqual({ action: 'allow' });
    await runAfterTasks();

    expect(mockedRecordUsage.mock.calls).toEqual([
      [{ ...call({ decision: 'error', creditsCost: null }), addedLatencyMs: null }],
      [{ ...call(), addedLatencyMs: 237 }],
    ]);
  });

  it('records no added latency when the request never awaited the verdict', async () => {
    mockedScanRequest.mockResolvedValue({ verdict: { action: 'allow' }, usageRecords: [call()] });

    startEnkryptInputGuardrail(Promise.resolve(scan), signal);
    await runAfterTasks();

    expect(mockedRecordUsage.mock.calls).toEqual([[{ ...call(), addedLatencyMs: null }]]);
  });

  it('scans log-only detectors in a second call that the verdict never waits for', async () => {
    const logOnlyResult = Promise.withResolvers<EnkryptGuardrailScanResult>();
    mockedScanRequest.mockImplementation(async resolved =>
      isLogOnly(resolved)
        ? logOnlyResult.promise
        : { verdict: { action: 'allow' }, usageRecords: [call()] }
    );
    jest.spyOn(performance, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(1_237.4);

    const guardrail = startEnkryptInputGuardrail(Promise.resolve(mixedScan), signal);

    expect(await guardrail.awaitVerdict()).toEqual({ action: 'allow' });
    expect(mockedScanRequest.mock.calls).toEqual([
      [
        { ...mixedScan, config: scan.config },
        expect.objectContaining({ timeoutMs: 30_000, signal }),
      ],
      [
        { ...mixedScan, config: logOnlyScan.config },
        expect.objectContaining({ timeoutMs: 30_000, signal }),
      ],
    ]);

    logOnlyResult.resolve({
      verdict: { action: 'unavailable', reason: 'timeout' },
      usageRecords: [call({ decision: 'error', creditsCost: 1 })],
    });
    await runAfterTasks();

    expect(mockedRecordUsage.mock.calls).toEqual([
      [{ ...call(), addedLatencyMs: 237 }],
      [{ ...call({ decision: 'error', creditsCost: 1 }), addedLatencyMs: null }],
    ]);
  });

  it('ignores a log-only verdict that settles before the blocking verdict', async () => {
    const blockingResult = Promise.withResolvers<EnkryptGuardrailScanResult>();
    mockedScanRequest.mockImplementation(async resolved =>
      isLogOnly(resolved)
        ? { verdict: { action: 'unavailable', reason: 'failed' }, usageRecords: [] }
        : blockingResult.promise
    );

    const guardrail = startEnkryptInputGuardrail(Promise.resolve(mixedScan), signal);
    const verdict = guardrail.awaitVerdict();
    await new Promise(resolve => setImmediate(resolve));
    blockingResult.resolve({ verdict: { action: 'allow' }, usageRecords: [] });

    expect(await verdict).toEqual({ action: 'allow' });
  });

  it('keeps the blocking verdict when the log-only scan throws unexpectedly', async () => {
    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockedScanRequest.mockImplementation(async resolved => {
      if (isLogOnly(resolved)) throw new RangeError('Maximum call stack size exceeded');
      return { verdict: { action: 'block', message: 'blocked' }, usageRecords: [call()] };
    });
    jest.spyOn(performance, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(1_000);

    const guardrail = startEnkryptInputGuardrail(Promise.resolve(mixedScan), signal);

    expect(await guardrail.awaitVerdict()).toEqual({ action: 'block', message: 'blocked' });
    await runAfterTasks();
    expect(errorLog).toHaveBeenCalledWith(
      '[enkrypt-guardrail] log-only scan failed unexpectedly',
      expect.any(Object)
    );
    expect(mockedRecordUsage.mock.calls).toEqual([[{ ...call(), addedLatencyMs: 0 }]]);
  });

  it('skips the verdict without waiting when every detector only logs', async () => {
    const logOnlyResult = Promise.withResolvers<EnkryptGuardrailScanResult>();
    mockedScanRequest.mockReturnValue(logOnlyResult.promise);
    jest.spyOn(performance, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(1_000.2);

    const guardrail = startEnkryptInputGuardrail(Promise.resolve(logOnlyScan), signal);

    expect(await guardrail.awaitVerdict()).toEqual({ action: 'skip' });
    expect(mockedScanRequest).toHaveBeenCalledTimes(1);
    expect(mockedScanRequest).toHaveBeenCalledWith(logOnlyScan, expect.anything());

    logOnlyResult.resolve({
      verdict: { action: 'allow' },
      usageRecords: [call({ decision: 'error', creditsCost: null }), call({ decision: 'error' })],
    });
    await runAfterTasks();

    expect(mockedRecordUsage.mock.calls).toEqual([
      [{ ...call({ decision: 'error', creditsCost: null }), addedLatencyMs: null }],
      [{ ...call({ decision: 'error' }), addedLatencyMs: 0 }],
    ]);
  });

  it('skips the scan and records nothing without a guardrail', async () => {
    const guardrail = startEnkryptInputGuardrail(Promise.resolve(null), signal);

    expect(await guardrail.awaitVerdict()).toEqual({ action: 'skip' });
    await runAfterTasks();

    expect(mockedScanRequest).not.toHaveBeenCalled();
    expect(mockedRecordUsage).not.toHaveBeenCalled();
  });
});
