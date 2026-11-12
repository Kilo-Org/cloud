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
  type EnkryptScanPart,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/detect';
import {
  joinSegments,
  renderSegment,
  type RequestSegment,
  type RequestToolDefinition,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/request-text';
import {
  ENKRYPT_VERDICT_CACHE_TTL_SECONDS,
  verdictCacheKeys,
  type EnkryptCachedScanResult,
  type EnkryptGuardrailRequest,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/verdict-cache';
import { ENKRYPT_MAX_CONCURRENT_CALLS } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/call-limiter';
import { redisClient } from '@kilocode/web-shared/lib/redis';
import type {
  EnkryptScanReport,
  EnkryptToolScanReport,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/report';
import type { EnkryptDetectRequestDetectors } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/detectors';
import { combinedVerdict, startEnkryptInputGuardrail } from './input-guardrail';

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
  status: 'ready',
  detectors: { injection_attack: detectors.injection_attack },
  blockingDetectors: ['injection_attack'],
} satisfies EnkryptGuardrailRequest['config'];

function segment(header: string, body: string | null): RequestSegment {
  return { header, body };
}

function render(segments: RequestSegment[]): string {
  return joinSegments(segments.map(renderSegment));
}

function tool(name: string, description: string): RequestToolDefinition {
  return { kind: 'tool', name, segments: [segment(`tool: ${name}`, description)] };
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a value');
  return value;
}

const scan: EnkryptGuardrailRequest = {
  sessionId: 'ses_guardrail',
  organizationId: '00000000-0000-4000-8000-000000000002',
  kiloUserId: 'oauth/google:123',
  apiKind: 'messages',
  clientRequestId: null,
  parts: {
    tools: [],
    system: [],
    conversation: [segment('user', 'run it'), segment('tool result: bash', 'tool output')],
  },
  config,
};

const partsScan: EnkryptGuardrailRequest = {
  ...scan,
  parts: {
    ...scan.parts,
    tools: [tool('bash', 'Runs a command.')],
    system: [segment('system', 'system prompt')],
  },
};

const mixedScan: EnkryptGuardrailRequest = {
  ...scan,
  config: {
    status: 'ready',
    detectors,
    blockingDetectors: ['injection_attack'],
  },
};

const logOnlyScan: EnkryptGuardrailRequest = {
  ...scan,
  config: {
    status: 'ready',
    detectors: { pii: detectors.pii },
    blockingDetectors: [],
  },
};

function isLogOnly({ config }: Pick<EnkryptGuardrailRequest, 'config'>) {
  return config.status === 'ready' && config.blockingDetectors.length === 0;
}

function partOf(resolved: EnkryptGuardrailScan): EnkryptScanPart {
  return resolved.coverage.part;
}

type RequestPart = keyof EnkryptGuardrailRequest['parts'];

/** The rendered segments of a part; for `tools`, of its first tool definition. */
function partSegments({ parts }: EnkryptGuardrailRequest, part: RequestPart): string[] {
  return part === 'tools'
    ? [render(required(parts.tools[0]).segments)]
    : parts[part].map(renderSegment);
}

function scanOf(request: EnkryptGuardrailRequest, part: RequestPart = 'conversation') {
  const { parts: _parts, ...rest } = request;
  return {
    ...rest,
    text: joinSegments(partSegments(request, part)),
    coverage: expect.objectContaining({ part }),
  };
}

function finalKey(request: EnkryptGuardrailRequest, part: RequestPart = 'conversation') {
  if (request.config.status !== 'ready') throw new Error('expected a ready config');
  const key = verdictCacheKeys(request, request.config, part, partSegments(request, part)).at(-1);
  if (!key) throw new Error('expected a nonempty part');
  return key;
}

function toolKey(request: EnkryptGuardrailRequest, definition: RequestToolDefinition) {
  if (request.config.status !== 'ready') throw new Error('expected a ready config');
  return required(
    verdictCacheKeys(request, request.config, 'tools', [render(definition.segments)])[0]
  );
}

const scanReport: EnkryptScanReport = {
  scan: 'blocking',
  part: 'conversation',
  detectors_enabled: ['injection_attack'],
  detectors_blocking: ['injection_attack'],
  verdict_cache: 'miss',
  total_characters: 26,
  total_segments: 2,
  cached_characters: 0,
  cached_segments: 0,
  omitted_attachments: 0,
  scanned_characters: 26,
  decision: 'allowed',
  error: null,
  detectors_fired: [],
  attempts: 1,
  credits_cost: 3,
  latency_ms: 120,
};

/** The aggregate of `partsScan`'s single tool definition, scanned with `scanReport`'s outcome. */
function toolsReport(overrides: Partial<EnkryptToolScanReport> = {}): EnkryptToolScanReport {
  return {
    scan: 'blocking',
    part: 'tools',
    detectors_enabled: ['injection_attack'],
    detectors_blocking: ['injection_attack'],
    verdict_cache: 'miss',
    tools_total: 1,
    tools_cached: 0,
    tools_scanned: 1,
    tools_flagged: 0,
    total_characters: render(required(partsScan.parts.tools[0]).segments).length,
    cached_characters: 0,
    scanned_characters: scanReport.scanned_characters,
    decision: 'allowed',
    error: null,
    detectors_fired: [],
    attempts: 1,
    credits_cost: 3,
    latency_ms: 120,
    flagged_tools: [],
    ...overrides,
  };
}

function call(overrides: Partial<EnkryptGuardrailCall> = {}): EnkryptGuardrailCall {
  return {
    organizationId: scan.organizationId,
    kiloUserId: scan.kiloUserId,
    sessionId: scan.sessionId,
    apiKind: scan.apiKind,
    decision: 'allowed',
    creditsCost: 3,
    scannedCharacters: 2_400,
    totalCharacters: 10_000,
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

  it('starts the request scan with a 60-second timeout', async () => {
    mockedScanRequest.mockResolvedValue({
      verdict: { action: 'allow' },
      report: scanReport,
      usageRecords: [],
    });

    const guardrail = startEnkryptInputGuardrail(Promise.resolve(scan), signal);
    await guardrail.awaitVerdict();

    expect(mockedScanRequest).toHaveBeenCalledWith(
      expect.objectContaining({ text: '[user]\nrun it\n\n[tool result: bash]\ntool output' }),
      expect.objectContaining({ timeoutMs: 60_000, signal })
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
        expect.objectContaining({ timeoutMs: 60_000, signal }),
      ],
      [
        scanOf({ ...request, config: logOnlyScan.config }),
        expect.objectContaining({ timeoutMs: 60_000, signal }),
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
    await new Promise(resolve => setImmediate(resolve));
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

  describe('with tools, system, and conversation parts', () => {
    const systemReport: EnkryptScanReport = { ...scanReport, part: 'system' };

    it('scans the tools, system prompt, and conversation separately for each detector set, longest first', async () => {
      mockedScanRequest.mockImplementation(async resolved => ({
        verdict: { action: 'allow' },
        report: { ...scanReport, part: partOf(resolved) },
        usageRecords: [call()],
      }));

      const request = { ...mixedScan, parts: partsScan.parts };
      const guardrail = startEnkryptInputGuardrail(Promise.resolve(request), signal);

      expect(await guardrail.awaitVerdict()).toEqual({ action: 'allow' });
      expect(mockedScanRequest.mock.calls.map(([resolved]) => resolved)).toEqual([
        scanOf({ ...request, config: scan.config }, 'conversation'),
        scanOf({ ...request, config: scan.config }, 'tools'),
        scanOf({ ...request, config: scan.config }, 'system'),
        scanOf({ ...request, config: logOnlyScan.config }, 'conversation'),
        scanOf({ ...request, config: logOnlyScan.config }, 'tools'),
        scanOf({ ...request, config: logOnlyScan.config }, 'system'),
      ]);
      await runAfterTasks();
      expect(mockedRedisSet.mock.calls.map(([key]) => key)).toEqual([
        finalKey({ ...request, config: scan.config }, 'tools'),
        finalKey({ ...request, config: scan.config }, 'system'),
        finalKey({ ...request, config: scan.config }, 'conversation'),
        finalKey({ ...request, config: logOnlyScan.config }, 'tools'),
        finalKey({ ...request, config: logOnlyScan.config }, 'system'),
        finalKey({ ...request, config: logOnlyScan.config }, 'conversation'),
      ]);
    });

    it('blocks when the system prompt blocks although the tools and conversation allow', async () => {
      mockedScanRequest.mockImplementation(async resolved =>
        partOf(resolved) === 'system'
          ? {
              verdict: { action: 'block', message: 'system prompt blocked' },
              report: {
                ...systemReport,
                decision: 'blocked',
                detectors_fired: ['injection_attack'],
              },
              usageRecords: [call({ decision: 'blocked' })],
            }
          : {
              verdict: { action: 'allow' },
              report: { ...scanReport, part: partOf(resolved) },
              usageRecords: [call()],
            }
      );

      const guardrail = startEnkryptInputGuardrail(Promise.resolve(partsScan), signal);

      expect(await guardrail.awaitVerdict()).toEqual({
        action: 'block',
        message: 'system prompt blocked',
      });
      expect(mockedRedisSet).toHaveBeenCalledWith(
        finalKey(partsScan, 'system'),
        { action: 'block', detectors: ['injection_attack'] },
        { ex: ENKRYPT_VERDICT_CACHE_TTL_SECONDS }
      );
      for (const part of ['tools', 'conversation'] as const) {
        expect(mockedRedisSet).toHaveBeenCalledWith(finalKey(partsScan, part), 'allow', {
          ex: ENKRYPT_VERDICT_CACHE_TTL_SECONDS,
          nx: true,
        });
      }
      const report = await guardrail.report();
      expect(report?.verdict).toBe('block');
      expect(report?.scans).toEqual([
        { ...toolsReport(), verdict_cache_write: 'written' },
        {
          ...systemReport,
          decision: 'blocked',
          detectors_fired: ['injection_attack'],
          verdict_cache_write: 'written',
        },
        { ...scanReport, verdict_cache_write: 'written' },
      ]);
    });

    it('is unavailable when one part could not be scanned and the other allows', async () => {
      mockedScanRequest.mockImplementation(async resolved =>
        partOf(resolved) === 'conversation'
          ? {
              verdict: { action: 'unavailable', reason: 'timeout' },
              report: { ...scanReport, decision: 'error_fail_closed', error: 'timeout' },
              usageRecords: [call({ decision: 'error' })],
            }
          : {
              verdict: { action: 'allow' },
              report: { ...scanReport, part: partOf(resolved) },
              usageRecords: [call()],
            }
      );

      const guardrail = startEnkryptInputGuardrail(Promise.resolve(partsScan), signal);

      expect(await guardrail.awaitVerdict()).toEqual({ action: 'unavailable', reason: 'timeout' });
      const report = await guardrail.report();
      expect(report).toMatchObject({ verdict: 'unavailable', unavailable_reason: 'timeout' });
      expect(report?.scans.map(each => [each.part, each.verdict_cache_write])).toEqual([
        ['tools', 'written'],
        ['system', 'written'],
        ['conversation', 'skipped'],
      ]);
      expect(mockedRedisSet.mock.calls.map(([key]) => key)).toEqual([
        finalKey(partsScan, 'tools'),
        finalKey(partsScan, 'system'),
      ]);
    });

    it('reports blocking scans, then log-only scans, each with its own cache write', async () => {
      const request = { ...mixedScan, parts: partsScan.parts };
      const blockingConversationKey = finalKey({ ...request, config: scan.config });
      const logOnlySystemKey = finalKey({ ...request, config: logOnlyScan.config }, 'system');
      mockedScanRequest.mockImplementation(async resolved => ({
        verdict: { action: 'allow' },
        report: {
          ...scanReport,
          part: partOf(resolved),
          scan: isLogOnly(resolved) ? 'log_only' : 'blocking',
        },
        usageRecords: [call()],
      }));
      mockedRedisSet.mockImplementation(async key => {
        if (key === blockingConversationKey) throw new Error('timeout');
        return key === logOnlySystemKey ? null : 'OK';
      });

      const guardrail = startEnkryptInputGuardrail(Promise.resolve(request), signal);

      expect(
        (await guardrail.report())?.scans.map(each => [
          each.scan,
          each.part,
          each.verdict_cache_write,
        ])
      ).toEqual([
        ['blocking', 'tools', 'written'],
        ['blocking', 'system', 'written'],
        ['blocking', 'conversation', 'failed'],
        ['log_only', 'tools', 'written'],
        ['log_only', 'system', 'skipped'],
        ['log_only', 'conversation', 'written'],
      ]);
    });

    it('records every part’s calls and the wait on the final blocking call', async () => {
      mockedScanRequest.mockImplementation(async resolved => ({
        verdict: { action: 'allow' },
        report: { ...scanReport, part: partOf(resolved) },
        usageRecords: [
          call({
            scannedCharacters: ['tools', 'system', 'conversation'].indexOf(partOf(resolved)) + 1,
          }),
        ],
      }));
      jest.spyOn(performance, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(1_237.4);

      const guardrail = startEnkryptInputGuardrail(Promise.resolve(partsScan), signal);
      await guardrail.awaitVerdict();
      await runAfterTasks();

      expect(mockedRecordUsage.mock.calls).toEqual([
        [{ ...call({ scannedCharacters: 1 }), addedLatencyMs: null }],
        [{ ...call({ scannedCharacters: 2 }), addedLatencyMs: null }],
        [{ ...call({ scannedCharacters: 3 }), addedLatencyMs: 237 }],
      ]);
    });
  });
});

describe('startEnkryptInputGuardrail with many tool definitions', () => {
  const actualScanRequest = jest.requireActual<{ scanRequest: typeof scanRequest }>(
    '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/detect'
  ).scanRequest;
  const tools = Array.from({ length: 12 }, (_, index) =>
    tool(`tool_${index}`, `Does thing ${index}.`)
  );
  const request: EnkryptGuardrailRequest = {
    ...mixedScan,
    parts: { ...partsScan.parts, tools },
  };
  /** Each detector set scans every tool, the system prompt, and the conversation. */
  const callsPerScanKind = tools.length + 2;

  type PendingCall = { kind: 'blocking' | 'log_only'; resolve: (response: Response) => void };

  /** Counts Enkrypt calls in flight; each waits until the test answers it. */
  function deferredFetch() {
    const state = {
      pending: [] as PendingCall[],
      started: [] as PendingCall['kind'][],
      inFlight: 0,
      maxInFlight: 0,
    };
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { detectors: Record<string, unknown> };
      const kind = 'injection_attack' in body.detectors ? 'blocking' : 'log_only';
      const response = Promise.withResolvers<Response>();
      state.started.push(kind);
      state.pending.push({ kind, resolve: response.resolve });
      state.inFlight++;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      try {
        return await response.promise;
      } finally {
        state.inFlight--;
      }
    });
    return state;
  }

  function detectResponse(status = 200) {
    return new Response(JSON.stringify({ summary: {} }), {
      status,
      headers: { 'content-type': 'application/json', 'x-enkrypt-credits-cost': '1' },
    });
  }

  async function settle() {
    for (let round = 0; round < 5; round++) await new Promise(resolve => setImmediate(resolve));
  }

  /** Answers the in-flight calls one at a time, oldest first, until `done` settles. */
  async function answerUntil(
    done: Promise<unknown>,
    calls: ReturnType<typeof deferredFetch>,
    respond: (index: number) => Response = () => detectResponse()
  ) {
    let finished = false;
    void done.finally(() => {
      finished = true;
    });
    let answered = 0;
    for (let round = 0; !finished; round++) {
      if (round > 200) throw new Error('the guardrail did not finish');
      await settle();
      const next = calls.pending.shift();
      if (next) next.resolve(respond(answered++));
    }
  }

  /** Every verdict cache key of the request's parts under `config`. */
  function cacheKeys(config: EnkryptGuardrailRequest['config']): Set<string> {
    if (config.status !== 'ready') throw new Error('expected a ready config');
    return new Set([
      ...tools.map(definition => toolKey({ ...request, config }, definition)),
      ...verdictCacheKeys(request, config, 'system', request.parts.system.map(renderSegment)),
      ...verdictCacheKeys(
        request,
        config,
        'conversation',
        request.parts.conversation.map(renderSegment)
      ),
    ]);
  }

  beforeEach(() => {
    jest.spyOn(console, 'debug').mockImplementation(() => {});
    mockedScanRequest.mockImplementation(actualScanRequest);
    mockedRedisMget.mockImplementation((async (keys: string[]) =>
      keys.map(() => null)) as unknown as typeof redisClient.mget);
  });

  it('keeps at most four Enkrypt calls in flight across blocking and log-only scans', async () => {
    const calls = deferredFetch();

    const guardrail = startEnkryptInputGuardrail(Promise.resolve(request), signal);
    // The first call fails transiently, so it is retried within the same limit.
    await answerUntil(guardrail.report(), calls, index =>
      index === 0 ? detectResponse(503) : detectResponse()
    );

    expect(ENKRYPT_MAX_CONCURRENT_CALLS).toBe(4);
    expect(calls.maxInFlight).toBe(ENKRYPT_MAX_CONCURRENT_CALLS);
    expect(calls.started).toHaveLength(2 * callsPerScanKind + 1);
    expect(await guardrail.awaitVerdict()).toEqual({ action: 'allow' });

    await runAfterTasks();
    expect(mockedRecordUsage).toHaveBeenCalledTimes(2 * callsPerScanKind + 1);
    const report = await guardrail.report();
    expect(report?.scans.reduce((total, each) => total + each.attempts, 0)).toBe(
      2 * callsPerScanKind + 1
    );
  });

  it('gives a free slot to a blocking call before a log-only call that waited longer', async () => {
    const calls = deferredFetch();
    const blockingKeys = cacheKeys(scan.config);
    const blockingLookups = Promise.withResolvers<void>();
    // The blocking scans start only after the log-only scans hold every slot and queued the rest.
    mockedRedisMget.mockImplementation((async (keys: string[]) => {
      if (keys.some(key => blockingKeys.has(key))) await blockingLookups.promise;
      return keys.map(() => null);
    }) as unknown as typeof redisClient.mget);

    const guardrail = startEnkryptInputGuardrail(Promise.resolve(request), signal);
    let startedAtVerdict: number | null = null;
    const verdict = guardrail.awaitVerdict().then(each => {
      startedAtVerdict = calls.started.length;
      return each;
    });
    await settle();
    expect(calls.started).toEqual(Array(4).fill('log_only'));
    blockingLookups.resolve();
    await settle();
    expect(calls.started).toHaveLength(4);

    await answerUntil(guardrail.report(), calls);

    expect(calls.started).toEqual([
      ...Array<string>(4).fill('log_only'),
      ...Array<string>(callsPerScanKind).fill('blocking'),
      ...Array<string>(callsPerScanKind - 4).fill('log_only'),
    ]);
    expect(await verdict).toEqual({ action: 'allow' });
    // The verdict did not wait for the queued log-only calls.
    expect(startedAtVerdict).toBeLessThan(2 * callsPerScanKind);
    expect(calls.maxInFlight).toBe(4);
  });

  it('reports one aggregated tools scan per detector set', async () => {
    const calls = deferredFetch();

    const guardrail = startEnkryptInputGuardrail(Promise.resolve(request), signal);
    await answerUntil(guardrail.report(), calls);

    const report = await guardrail.report();
    expect(report?.scans.map(each => [each.scan, each.part])).toEqual([
      ['blocking', 'tools'],
      ['blocking', 'system'],
      ['blocking', 'conversation'],
      ['log_only', 'tools'],
      ['log_only', 'system'],
      ['log_only', 'conversation'],
    ]);
    for (const kind of ['blocking', 'log_only'] as const) {
      expect(report?.scans.find(each => each.scan === kind && each.part === 'tools')).toMatchObject(
        {
          tools_total: 12,
          tools_cached: 0,
          tools_scanned: 12,
          tools_flagged: 0,
          decision: 'allowed',
          attempts: 12,
          credits_cost: 12,
          verdict_cache: 'miss',
          verdict_cache_write: 'written',
        }
      );
    }
  });

  it.each<[string, ('OK' | null | Error)[], string]>([
    ['failed when any write failed', [null, 'OK', new Error('timeout')], 'failed'],
    ['written when any was written', [null, 'OK', null], 'written'],
    ['skipped when none was written', [null, null, null], 'skipped'],
  ])('reports the tools cache write as %s', async (_name, blockingWrites, expected) => {
    const fewTools = tools.slice(0, 3);
    const fewToolsRequest = { ...request, parts: { ...request.parts, tools: fewTools } };
    const blockingToolKeys = fewTools.map(definition =>
      toolKey({ ...fewToolsRequest, config: scan.config }, definition)
    );
    mockedScanRequest.mockImplementation(async resolved => ({
      verdict: { action: 'allow' },
      report: {
        ...scanReport,
        part: partOf(resolved),
        scan: isLogOnly(resolved) ? 'log_only' : 'blocking',
      },
      usageRecords: [call()],
    }));
    mockedRedisSet.mockImplementation(async key => {
      const index = blockingToolKeys.indexOf(key);
      const write = index === -1 ? 'OK' : blockingWrites[index];
      if (write instanceof Error) throw write;
      return write ?? null;
    });

    const guardrail = startEnkryptInputGuardrail(Promise.resolve(fewToolsRequest), signal);
    await runAfterTasks();

    const report = await guardrail.report();
    expect(report?.scans.map(each => [each.scan, each.part, each.verdict_cache_write])).toEqual([
      ['blocking', 'tools', expected],
      ['blocking', 'system', 'written'],
      ['blocking', 'conversation', 'written'],
      ['log_only', 'tools', 'written'],
      ['log_only', 'system', 'written'],
      ['log_only', 'conversation', 'written'],
    ]);
    expect(report?.scans[0]).toMatchObject({ tools_total: 3, attempts: 3, credits_cost: 9 });
    expect(mockedRecordUsage).toHaveBeenCalledTimes(2 * (fewTools.length + 2));
  });
});

describe('combinedVerdict', () => {
  function result(verdict: EnkryptGuardrailScanResult['verdict']): EnkryptCachedScanResult {
    return { verdict, usageRecords: [], report: null, cacheEntries: [] };
  }

  const block = { action: 'block', message: 'blocked' } as const;
  const unavailable = { action: 'unavailable', reason: 'transient' } as const;
  const allow = { action: 'allow' } as const;

  it.each<[string, EnkryptGuardrailScanResult['verdict'][], EnkryptGuardrailScanResult['verdict']]>(
    [
      ['no scans', [], { action: 'skip' }],
      ['only skips', [{ action: 'skip' }], { action: 'skip' }],
      ['an allow over a skip', [{ action: 'skip' }, allow], allow],
      ['an unavailable scan over an allow', [allow, unavailable], unavailable],
      ['a block over an unavailable scan', [unavailable, block], block],
      ['a block over an allow', [block, allow], block],
    ]
  )('acts on %s', (_name, verdicts, expected) => {
    expect(combinedVerdict(verdicts.map(result))).toEqual(expected);
  });
});
