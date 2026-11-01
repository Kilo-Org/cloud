import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { after } from 'next/server';
import {
  recordEnkryptGuardrailCharge,
  type EnkryptGuardrailCall,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/charges';
import {
  scanRequest,
  type EnkryptGuardrailScan,
  type EnkryptGuardrailScanResult,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/detect';
import { startEnkryptInputGuardrail } from './input-guardrail';

jest.mock('next/server', () => ({
  ...jest.requireActual<Record<string, unknown>>('next/server'),
  after: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/charges', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/charges'
  ),
  recordEnkryptGuardrailCharge: jest.fn(),
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
const mockedRecordCharge = jest.mocked(recordEnkryptGuardrailCharge);
const mockedScanRequest = jest.mocked(scanRequest);

const scan: EnkryptGuardrailScan = {
  sessionId: 'ses_guardrail',
  organizationId: '00000000-0000-4000-8000-000000000002',
  kiloUserId: 'oauth/google:123',
  apiKind: 'messages',
  clientRequestId: null,
  text: 'tool output',
  config: { scanToolResults: true, status: 'ready', detectors: {}, blockingDetectors: [] },
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
  await Promise.all(mockedAfter.mock.calls.map(([task]) => (task as () => Promise<void>)()));
}

beforeEach(() => {
  mockedAfter.mockReset();
  mockedRecordCharge.mockReset().mockResolvedValue(undefined);
  mockedScanRequest.mockReset();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('startEnkryptInputGuardrail', () => {
  it('starts the request scan with a 30-second timeout', async () => {
    mockedScanRequest.mockResolvedValue({ verdict: { action: 'allow' }, charges: [] });

    const guardrail = startEnkryptInputGuardrail(Promise.resolve(scan));
    await guardrail.awaitVerdict();

    expect(mockedScanRequest).toHaveBeenCalledWith(
      scan,
      expect.objectContaining({ timeoutMs: 30_000 })
    );
  });

  it('records the wait for the verdict on the final call of the request only', async () => {
    const result: EnkryptGuardrailScanResult = {
      verdict: { action: 'allow' },
      charges: [call({ decision: 'error', creditsCost: null }), call()],
    };
    mockedScanRequest.mockResolvedValue(result);
    jest.spyOn(performance, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(1_237.4);

    const guardrail = startEnkryptInputGuardrail(Promise.resolve(scan));
    expect(await guardrail.awaitVerdict()).toEqual({ action: 'allow' });
    await runAfterTasks();

    expect(mockedRecordCharge.mock.calls).toEqual([
      [{ ...call({ decision: 'error', creditsCost: null }), addedLatencyMs: null }],
      [{ ...call(), addedLatencyMs: 237 }],
    ]);
  });

  it('records no added latency when the request never awaited the verdict', async () => {
    mockedScanRequest.mockResolvedValue({ verdict: { action: 'allow' }, charges: [call()] });

    startEnkryptInputGuardrail(Promise.resolve(scan));
    await runAfterTasks();

    expect(mockedRecordCharge.mock.calls).toEqual([[{ ...call(), addedLatencyMs: null }]]);
  });

  it('skips the scan and records nothing without a guardrail', async () => {
    const guardrail = startEnkryptInputGuardrail(Promise.resolve(null));

    expect(await guardrail.awaitVerdict()).toEqual({ action: 'skip' });
    await runAfterTasks();

    expect(mockedScanRequest).not.toHaveBeenCalled();
    expect(mockedRecordCharge).not.toHaveBeenCalled();
  });
});
