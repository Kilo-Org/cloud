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

const config = {
  scanToolResults: true,
  status: 'ready',
  detectors: {},
  blockingDetectors: [],
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
    mockedScanRequest.mockResolvedValue({ verdict: { action: 'allow' }, usageRecords: [] });

    const guardrail = startEnkryptInputGuardrail(Promise.resolve(scan), signal);
    await guardrail.awaitVerdict();

    expect(mockedScanRequest).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'system prompt\n\ntool output' }),
      expect.objectContaining({ timeoutMs: 30_000, signal })
    );
  });

  it('caches an allowed request by its full content while after() keeps the function alive', async () => {
    mockedScanRequest.mockResolvedValue({ verdict: { action: 'allow' }, usageRecords: [] });

    startEnkryptInputGuardrail(Promise.resolve(scan), signal);
    expect(mockedAfter).toHaveBeenCalledWith(expect.any(Promise));
    await runAfterTasks();

    const finalKey = verdictCacheKeys(scan, config, scan.segments).at(-1);
    expect(mockedRedisSet.mock.calls).toEqual([
      [finalKey, '1', { ex: ENKRYPT_VERDICT_CACHE_TTL_SECONDS }],
    ]);
  });

  it.each<[string, EnkryptGuardrailScanResult['verdict']]>([
    ['blocked', { action: 'block', message: 'blocked' }],
    ['unavailable', { action: 'unavailable', reason: 'timeout' }],
  ])('does not cache a %s request', async (_name, verdict) => {
    mockedScanRequest.mockResolvedValue({ verdict, usageRecords: [call()] });

    const guardrail = startEnkryptInputGuardrail(Promise.resolve(scan), signal);
    await guardrail.awaitVerdict();
    await runAfterTasks();

    expect(mockedRedisSet).not.toHaveBeenCalled();
  });

  it('keeps recording usage when the cache write fails', async () => {
    mockedScanRequest.mockResolvedValue({ verdict: { action: 'allow' }, usageRecords: [call()] });
    mockedRedisSet.mockRejectedValue(new Error('timeout'));

    startEnkryptInputGuardrail(Promise.resolve(scan), signal);
    await runAfterTasks();

    expect(mockedRecordUsage).toHaveBeenCalledTimes(1);
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

  it('skips the scan and records nothing without a guardrail', async () => {
    const guardrail = startEnkryptInputGuardrail(Promise.resolve(null), signal);

    expect(await guardrail.awaitVerdict()).toEqual({ action: 'skip' });
    await runAfterTasks();

    expect(mockedScanRequest).not.toHaveBeenCalled();
    expect(mockedRecordUsage).not.toHaveBeenCalled();
    expect(mockedRedisMget).not.toHaveBeenCalled();
    expect(mockedRedisSet).not.toHaveBeenCalled();
  });
});
