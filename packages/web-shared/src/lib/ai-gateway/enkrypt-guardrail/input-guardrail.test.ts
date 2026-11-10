import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { after } from 'next/server';
import {
  recordEnkryptUsage,
  type EnkryptGuardrailCall,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/usage';
import {
  scanRequest,
  type EnkryptGuardrailScanResult,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/detect';
import {
  ENKRYPT_VERDICT_CACHE_TTL_SECONDS,
  verdictCacheKeys,
  type EnkryptGuardrailRequest,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/verdict-cache';
import { redisClient } from '@kilocode/web-shared/lib/redis';
import type { EnkryptScanReport } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/report';
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
jest.mock('@kilocode/web-shared/lib/redis', () => ({
  redisClient: { mget: jest.fn(), set: jest.fn() },
}));

const mockedAfter = jest.mocked(after);
const mockedRecordUsage = jest.mocked(recordEnkryptUsage);
const mockedScanRequest = jest.mocked(scanRequest);
const mockedRedisMget = jest.mocked(redisClient.mget);
const mockedRedisSet = jest.mocked(redisClient.set);
const signal = new AbortController().signal;

const detectors = {
  injection_attack: { enabled: true, need_explanation: false },
  pii: { enabled: true, entities: ['secrets'] },
} satisfies EnkryptDetectRequestDetectors;

const config = {
  scanToolResults: true,
  status: 'ready',
  detectors: { injection_attack: detectors.injection_attack },
  blockingDetectors: ['injection_attack'],
} satisfies EnkryptGuardrailRequest['config'];

const scan: EnkryptGuardrailRequest = {
  sessionId: 'ses_guardrail',
  organizationId: '00000000-0000-4000-8000-000000000002',
  kiloUserId: 'oauth/google:123',
  apiKind: 'messages',
  clientRequestId: null,
  segments: ['system prompt', 'tool output'],
  config,
};

const mixedScan: EnkryptGuardrailRequest = {
  ...scan,
  config: {
    scanToolResults: true,
    status: 'ready',
    detectors,
    blockingDetectors: ['injection_attack'],
  },
};

const logOnlyScan: EnkryptGuardrailRequest = {
  ...scan,
  config: {
    scanToolResults: true,
    status: 'ready',
    detectors: { pii: detectors.pii },
    blockingDetectors: [],
  },
};

function isLogOnly({ config }: Pick<EnkryptGuardrailRequest, 'config'>) {
  return config.status === 'ready' && config.blockingDetectors.length === 0;
}

function scanOf({ segments, ...request }: EnkryptGuardrailRequest) {
  return { ...request, text: segments.join('\n\n'), coverage: expect.any(Object) };
}

function finalKey(request: EnkryptGuardrailRequest) {
  if (request.config.status !== 'ready') throw new Error('expected a ready config');
  const key = verdictCacheKeys(request, request.config, request.segments).at(-1);
  if (!key) throw new Error('expected a nonempty request');
  return key;
}

const scanReport: EnkryptScanReport = {
  scan: 'blocking',
  detectors_enabled: ['injection_attack'],
  detectors_blocking: ['injection_attack'],
  verdict_cache: 'miss',
  total_characters: 26,
  total_segments: 2,
  cached_characters: 0,
  cached_segments: 0,
  scanned_characters: 26,
  decision: 'allowed',
  error: null,
  detectors_fired: [],
  attempts: 1,
  credits_cost: 3,
  latency_ms: 120,
};

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
  await Promise.all(
    mockedAfter.mock.calls.map(([task]) => (typeof task === 'function' ? task() : task))
  );
}

beforeEach(() => {
  mockedAfter.mockReset();
  mockedRecordUsage.mockReset().mockResolvedValue(undefined);
  mockedScanRequest.mockReset();
  mockedRedisMget.mockReset().mockResolvedValue([null, null]);
  mockedRedisSet.mockReset().mockResolvedValue('OK');
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
    mockedScanRequest.mockResolvedValue({
      verdict: { action: 'allow' },
      report: scanReport,
      usageRecords: [],
    });

    const guardrail = startEnkryptInputGuardrail(Promise.resolve(scan), signal);
    await guardrail.awaitVerdict();

    expect(mockedScanRequest).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'system prompt\n\ntool output' }),
      expect.objectContaining({ timeoutMs: 30_000, signal })
    );
  });

  it('caches an allowed request by its full content while after() keeps the function alive', async () => {
    mockedScanRequest.mockResolvedValue({
      verdict: { action: 'allow' },
      report: scanReport,
      usageRecords: [call()],
    });

    startEnkryptInputGuardrail(Promise.resolve(scan), signal);
    expect(mockedAfter).toHaveBeenCalledWith(expect.any(Promise));
    await runAfterTasks();

    expect(mockedRedisSet.mock.calls).toEqual([
      [finalKey(scan), 'allow', { ex: ENKRYPT_VERDICT_CACHE_TTL_SECONDS, nx: true }],
    ]);
  });

  it('caches the blocking and log-only scans under separate keys', async () => {
    mockedScanRequest.mockResolvedValue({
      verdict: { action: 'allow' },
      report: scanReport,
      usageRecords: [call()],
    });

    startEnkryptInputGuardrail(Promise.resolve(mixedScan), signal);
    await runAfterTasks();

    const blockingKey = finalKey({ ...mixedScan, config: scan.config });
    const logOnlyKey = finalKey({ ...mixedScan, config: logOnlyScan.config });
    expect(blockingKey).not.toBe(logOnlyKey);
    expect(mockedRedisSet.mock.calls.map(([key]) => key)).toEqual([blockingKey, logOnlyKey]);
  });

  it('does not delay an allowed request for its cache write', async () => {
    mockedScanRequest.mockResolvedValue({
      verdict: { action: 'allow' },
      report: scanReport,
      usageRecords: [call()],
    });
    const write = Promise.withResolvers<'OK'>();
    mockedRedisSet.mockReturnValue(write.promise);

    const guardrail = startEnkryptInputGuardrail(Promise.resolve(scan), signal);

    expect(await guardrail.awaitVerdict()).toEqual({ action: 'allow' });
    write.resolve('OK');
    await runAfterTasks();
  });

  it.each<[string, EnkryptGuardrailScanResult['verdict']]>([
    ['locally blocked without a detector verdict', { action: 'block', message: 'too large' }],
    ['unavailable', { action: 'unavailable', reason: 'timeout' }],
  ])('does not cache a %s request', async (_name, verdict) => {
    mockedScanRequest.mockResolvedValue({ verdict, report: scanReport, usageRecords: [call()] });

    const guardrail = startEnkryptInputGuardrail(Promise.resolve(scan), signal);
    await guardrail.awaitVerdict();
    await runAfterTasks();

    expect(mockedRedisSet).not.toHaveBeenCalled();
  });

  it('persists a detector block before returning its verdict', async () => {
    mockedScanRequest.mockResolvedValue({
      verdict: { action: 'block', message: 'blocked' },
      report: { ...scanReport, decision: 'blocked', detectors_fired: ['injection_attack'] },
      usageRecords: [call({ decision: 'blocked' })],
    });
    const write = Promise.withResolvers<'OK'>();
    mockedRedisSet.mockReturnValue(write.promise);
    const settled = jest.fn();

    const guardrail = startEnkryptInputGuardrail(Promise.resolve(scan), signal);
    const verdict = guardrail.awaitVerdict().then(settled);
    await new Promise(resolve => setImmediate(resolve));

    expect(mockedRedisSet).toHaveBeenCalledWith(
      finalKey(scan),
      { action: 'block', detectors: ['injection_attack'] },
      { ex: ENKRYPT_VERDICT_CACHE_TTL_SECONDS }
    );
    expect(settled).not.toHaveBeenCalled();
    write.resolve('OK');
    await verdict;
    expect(settled).toHaveBeenCalledWith({ action: 'block', message: 'blocked' });
    await runAfterTasks();
    expect(mockedRecordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'blocked' })
    );
    expect((await guardrail.report())?.scans[0]).toMatchObject({
      decision: 'blocked',
      verdict_cache_write: 'written',
    });
  });

  it('rejects a cached block without another scan, cache write, or usage charge', async () => {
    mockedRedisMget.mockResolvedValue([
      null,
      JSON.stringify({ action: 'block', detectors: ['injection_attack'] }),
    ]);

    const guardrail = startEnkryptInputGuardrail(Promise.resolve(scan), signal);

    expect(await guardrail.awaitVerdict()).toMatchObject({
      action: 'block',
      message: expect.stringContaining('injection_attack'),
    });
    await runAfterTasks();
    expect(mockedScanRequest).not.toHaveBeenCalled();
    expect(mockedRedisSet).not.toHaveBeenCalled();
    expect(mockedRecordUsage).not.toHaveBeenCalled();
    expect((await guardrail.report())?.scans[0]).toMatchObject({
      decision: 'blocked',
      verdict_cache: 'hit',
      scanned_characters: 0,
      attempts: 0,
      verdict_cache_write: 'skipped',
    });
  });

  it.each(['allow', 'block'] as const)(
    'keeps the %s verdict and usage when its cache write fails',
    async action => {
      mockedScanRequest.mockResolvedValue({
        verdict: action === 'allow' ? { action } : { action, message: 'blocked' },
        report: { ...scanReport, detectors_fired: ['injection_attack'] },
        usageRecords: [call({ decision: action === 'allow' ? 'allowed' : 'blocked' })],
      });
      mockedRedisSet.mockRejectedValue(new Error('timeout'));

      const guardrail = startEnkryptInputGuardrail(Promise.resolve(scan), signal);
      expect((await guardrail.awaitVerdict()).action).toBe(action);
      await runAfterTasks();

      expect(mockedRecordUsage).toHaveBeenCalledTimes(1);
      expect((await guardrail.report())?.scans[0]?.verdict_cache_write).toBe('failed');
    }
  );

  it('records the wait for the verdict on the final call of the request only', async () => {
    const result: EnkryptGuardrailScanResult = {
      verdict: { action: 'allow' },
      report: scanReport,
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
    mockedScanRequest.mockResolvedValue({
      verdict: { action: 'allow' },
      report: scanReport,
      usageRecords: [call()],
    });

    startEnkryptInputGuardrail(Promise.resolve(scan), signal);
    await runAfterTasks();

    expect(mockedRecordUsage.mock.calls).toEqual([[{ ...call(), addedLatencyMs: null }]]);
  });

  it('preserves the inference association across blocking retries and a nonblocking log-only scan', async () => {
    const microdollarUsageId = '00000000-0000-4000-8000-000000000003';
    const request = { ...mixedScan, microdollarUsageId };
    const logOnlyResult = Promise.withResolvers<EnkryptGuardrailScanResult>();
    mockedScanRequest.mockImplementation(async resolved =>
      isLogOnly(resolved)
        ? logOnlyResult.promise
        : {
            verdict: { action: 'allow' },
            report: scanReport,
            usageRecords: [
              call({ microdollarUsageId, decision: 'error', creditsCost: null }),
              call({ microdollarUsageId }),
            ],
          }
    );
    jest.spyOn(performance, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(1_237.4);

    const guardrail = startEnkryptInputGuardrail(Promise.resolve(request), signal);

    expect(await guardrail.awaitVerdict()).toEqual({ action: 'allow' });
    expect(mockedScanRequest.mock.calls).toEqual([
      [
        scanOf({ ...request, config: scan.config }),
        expect.objectContaining({ timeoutMs: 30_000, signal }),
      ],
      [
        scanOf({ ...request, config: logOnlyScan.config }),
        expect.objectContaining({ timeoutMs: 30_000, signal }),
      ],
    ]);

    logOnlyResult.resolve({
      verdict: { action: 'unavailable', reason: 'timeout' },
      report: scanReport,
      usageRecords: [call({ microdollarUsageId, decision: 'error', creditsCost: 1 })],
    });
    await runAfterTasks();

    expect(mockedRecordUsage.mock.calls).toEqual([
      [
        {
          ...call({ microdollarUsageId, decision: 'error', creditsCost: null }),
          addedLatencyMs: null,
        },
      ],
      [{ ...call({ microdollarUsageId }), addedLatencyMs: 237 }],
      [
        {
          ...call({ microdollarUsageId, decision: 'error', creditsCost: 1 }),
          addedLatencyMs: null,
        },
      ],
    ]);
  });

  it('ignores a log-only verdict that settles before the blocking verdict', async () => {
    const blockingResult = Promise.withResolvers<EnkryptGuardrailScanResult>();
    mockedScanRequest.mockImplementation(async resolved =>
      isLogOnly(resolved)
        ? {
            verdict: { action: 'unavailable', reason: 'failed' },
            report: scanReport,
            usageRecords: [],
          }
        : blockingResult.promise
    );

    const guardrail = startEnkryptInputGuardrail(Promise.resolve(mixedScan), signal);
    const verdict = guardrail.awaitVerdict();
    await new Promise(resolve => setImmediate(resolve));
    blockingResult.resolve({ verdict: { action: 'allow' }, report: scanReport, usageRecords: [] });

    expect(await verdict).toEqual({ action: 'allow' });
  });

  it('keeps the blocking verdict when the log-only scan throws unexpectedly', async () => {
    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockedScanRequest.mockImplementation(async resolved => {
      if (isLogOnly(resolved)) throw new RangeError('Maximum call stack size exceeded');
      return {
        verdict: { action: 'block', message: 'blocked' },
        report: scanReport,
        usageRecords: [call()],
      };
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
    expect(mockedScanRequest).toHaveBeenCalledWith(scanOf(logOnlyScan), expect.anything());

    logOnlyResult.resolve({
      verdict: { action: 'allow' },
      report: { ...scanReport, scan: 'log_only', decision: 'error_logged', error: 'http_503' },
      usageRecords: [call({ decision: 'error', creditsCost: null }), call({ decision: 'error' })],
    });
    await runAfterTasks();

    expect(mockedRecordUsage.mock.calls).toEqual([
      [{ ...call({ decision: 'error', creditsCost: null }), addedLatencyMs: null }],
      [{ ...call({ decision: 'error' }), addedLatencyMs: 0 }],
    ]);
    expect(mockedRedisSet).toHaveBeenCalledWith(
      finalKey(logOnlyScan),
      'allow',
      expect.objectContaining({ nx: true })
    );
  });

  it('reports the settings, verdict, wait, and each scan with its cache write', async () => {
    mockedScanRequest.mockImplementation(async resolved =>
      isLogOnly(resolved)
        ? {
            verdict: { action: 'allow' },
            report: { ...scanReport, scan: 'log_only', decision: 'error_logged', error: 'timeout' },
            usageRecords: [call({ decision: 'error' })],
          }
        : { verdict: { action: 'allow' }, report: scanReport, usageRecords: [call()] }
    );
    jest.spyOn(performance, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(1_237.4);

    const guardrail = startEnkryptInputGuardrail(Promise.resolve(mixedScan), signal);
    await guardrail.awaitVerdict();

    expect(await guardrail.report()).toEqual({
      settings: {
        status: 'ready',
        scan_tool_results: true,
        detectors: [
          { detector: 'injection_attack', action: 'block' },
          { detector: 'pii', action: 'log', pii_entities: ['secrets'] },
        ],
      },
      verdict: 'allow',
      unavailable_reason: null,
      added_latency_ms: 237,
      scans: [
        { ...scanReport, verdict_cache_write: 'written' },
        {
          ...scanReport,
          scan: 'log_only',
          decision: 'error_logged',
          error: 'timeout',
          verdict_cache_write: 'written',
        },
      ],
    });
  });

  it('reports an NX cache write no-op as skipped while retaining the scan usage', async () => {
    mockedScanRequest.mockResolvedValue({
      verdict: { action: 'allow' },
      report: scanReport,
      usageRecords: [call()],
    });
    mockedRedisSet.mockResolvedValue(null);

    const guardrail = startEnkryptInputGuardrail(Promise.resolve(scan), signal);

    expect(await guardrail.awaitVerdict()).toEqual({ action: 'allow' });
    await runAfterTasks();

    expect(mockedScanRequest).toHaveBeenCalledTimes(1);
    expect(mockedRedisSet).toHaveBeenCalledWith(finalKey(scan), 'allow', {
      ex: ENKRYPT_VERDICT_CACHE_TTL_SECONDS,
      nx: true,
    });
    expect((await guardrail.report())?.scans).toEqual([
      { ...scanReport, verdict_cache_write: 'skipped' },
    ]);
    expect(mockedRecordUsage).toHaveBeenCalledTimes(1);
    expect(mockedRecordUsage).toHaveBeenCalledWith(expect.objectContaining(call()));
  });

  it('reports a failed cache write', async () => {
    mockedScanRequest.mockResolvedValue({
      verdict: { action: 'allow' },
      report: scanReport,
      usageRecords: [call()],
    });
    mockedRedisSet.mockRejectedValue(new Error('timeout'));

    const guardrail = startEnkryptInputGuardrail(Promise.resolve(scan), signal);

    expect((await guardrail.report())?.scans).toEqual([
      { ...scanReport, verdict_cache_write: 'failed' },
    ]);
  });

  it('reports the settings of a log-only guardrail whose scan throws unexpectedly', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    mockedScanRequest.mockRejectedValue(new RangeError('Maximum call stack size exceeded'));

    const guardrail = startEnkryptInputGuardrail(Promise.resolve(logOnlyScan), signal);

    expect(await guardrail.report()).toEqual({
      settings: {
        status: 'ready',
        scan_tool_results: true,
        detectors: [{ detector: 'pii', action: 'log', pii_entities: ['secrets'] }],
      },
      verdict: 'skip',
      unavailable_reason: null,
      added_latency_ms: null,
      scans: [],
    });
  });

  it('reports a rejected request whose scan could not be prepared', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});

    const guardrail = startEnkryptInputGuardrail(Promise.reject(new Error('boom')), signal);

    expect(await guardrail.report()).toEqual({
      settings: null,
      verdict: 'unavailable',
      unavailable_reason: 'failed',
      added_latency_ms: null,
      scans: [],
    });
  });

  it('skips the scan and records nothing without a guardrail', async () => {
    const guardrail = startEnkryptInputGuardrail(Promise.resolve(null), signal);

    expect(await guardrail.awaitVerdict()).toEqual({ action: 'skip' });
    await runAfterTasks();

    expect(mockedScanRequest).not.toHaveBeenCalled();
    expect(mockedRecordUsage).not.toHaveBeenCalled();
    expect(mockedRedisMget).not.toHaveBeenCalled();
    expect(mockedRedisSet).not.toHaveBeenCalled();
    expect(await guardrail.report()).toBeNull();
  });
});
