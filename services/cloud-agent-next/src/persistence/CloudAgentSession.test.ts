/**
 * Focused unit tests for the CloudAgentSession attention scheduling helper.
 *
 * The orchestrator's task wires attention events through `getIngestHandler` as
 * a synchronous `ctx.waitUntil` handoff. The helper under test here is
 * `scheduleCloudAgentAttention(ctx, deps, event)`, which is exactly what
 * `getIngestHandler` calls. This keeps the private-field-heavy DO out of the
 * test surface while still proving the full contract:
 *
 *   - scheduling: the helper is synchronous and hands the IO to ctx.waitUntil;
 *   - safe payload: only kiloUserId, kiloSessionId, requestId, and intent
 *     are forwarded to the binding; no reason/error message leaks;
 *   - missing metadata: the IO is skipped, the binding is never called;
 *   - error privacy: thrown errors and accepted:false outcomes emit a logger
 *     warning that does NOT contain requestId, reason, or error.message;
 *   - duplicates pass through: the same (requestId, intent) is forwarded
 *     every time — the outbox downstream owns dedup.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

vi.mock('../logger.js', () => {
  const logger = {
    setTags: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withFields: vi.fn(),
  };
  logger.withFields.mockReturnValue(logger);
  return { logger };
});

import { logger } from '../logger.js';
import {
  scheduleCloudAgentAttention,
  type CloudAgentAttentionDeps,
} from './cloud-agent-attention-scheduler.js';
import type { AttentionEvent } from '../websocket/ingest-attention-classifier.js';
import type { SessionMetadata } from './session-metadata.js';
import type {
  RecordCloudAgentSessionAttentionParams,
  RecordCloudAgentSessionAttentionResult,
} from '@kilocode/session-ingest-contracts';

type RecordAttentionFn = (
  params: RecordCloudAgentSessionAttentionParams
) => Promise<RecordCloudAgentSessionAttentionResult>;

type AttentionEnv = CloudAgentAttentionDeps['env'];

function makeAttentionEvent(intent: AttentionEvent['intent'], requestId = 'req_1'): AttentionEvent {
  return { requestId, intent };
}

function makeMetadata(overrides?: { userId?: string; kiloSessionId?: string }): {
  identity: { userId?: string };
  auth: { kiloSessionId?: string };
} {
  return {
    identity: {
      userId: overrides && 'userId' in overrides ? overrides.userId : 'user_1',
    },
    auth: {
      kiloSessionId: overrides && 'kiloSessionId' in overrides ? overrides.kiloSessionId : 'kilo_1',
    },
  };
}

function makeDeps(overrides?: {
  metadata?: ReturnType<typeof makeMetadata> | null;
  recordCloudAgentSessionAttention?: Mock<RecordAttentionFn>;
  sessionId?: string;
}): {
  deps: CloudAgentAttentionDeps;
  recordCloudAgentSessionAttention: Mock<RecordAttentionFn>;
  getMetadata: ReturnType<typeof vi.fn>;
} {
  const recordCloudAgentSessionAttention =
    overrides?.recordCloudAgentSessionAttention ??
    vi.fn<RecordAttentionFn>().mockResolvedValue({ accepted: true });
  const env: AttentionEnv = {
    SESSION_INGEST: { recordCloudAgentSessionAttention },
  };
  const getMetadata = vi
    .fn()
    .mockResolvedValue(
      overrides?.metadata === null ? null : (overrides?.metadata ?? makeMetadata())
    );
  const deps: CloudAgentAttentionDeps = {
    sessionId: (overrides?.sessionId ?? 'sess_test') as CloudAgentAttentionDeps['sessionId'],
    getMetadata: getMetadata as unknown as () => Promise<SessionMetadata | null | undefined>,
    env,
  };
  return { deps, recordCloudAgentSessionAttention, getMetadata };
}

async function flushWaitUntil(promise: Promise<unknown>): Promise<void> {
  await promise;
  await new Promise(resolve => setImmediate(resolve));
}

function getWarnCalls(): string {
  const calls = vi.mocked(logger.warn).mock.calls;
  return calls.map((args: unknown[]) => args.map(String).join(' ')).join('\n');
}

describe('scheduleCloudAgentAttention', () => {
  beforeEach(() => {
    vi.mocked(logger.warn).mockClear();
  });

  afterEach(() => {
    vi.mocked(logger.warn).mockClear();
  });

  it('forwards the safe payload shape to the binding', async () => {
    const { deps, recordCloudAgentSessionAttention } = makeDeps();
    const waitUntil = vi.fn((p: Promise<unknown>) => p);

    scheduleCloudAgentAttention(
      { waitUntil },
      deps,
      makeAttentionEvent({ raise: 'question' }, 'req_q')
    );

    expect(waitUntil).toHaveBeenCalledTimes(1);
    await flushWaitUntil(waitUntil.mock.calls[0]?.[0] as Promise<unknown>);
    expect(recordCloudAgentSessionAttention).toHaveBeenCalledTimes(1);
    expect(recordCloudAgentSessionAttention).toHaveBeenCalledWith({
      kiloUserId: 'user_1',
      kiloSessionId: 'kilo_1',
      requestId: 'req_q',
      intent: { kind: 'raise', reason: 'question' },
    });
  });

  it('maps a permission raise to { kind: "raise", reason: "permission" }', async () => {
    const { deps, recordCloudAgentSessionAttention } = makeDeps();
    const waitUntil = vi.fn((p: Promise<unknown>) => p);

    scheduleCloudAgentAttention(
      { waitUntil },
      deps,
      makeAttentionEvent({ raise: 'permission' }, 'req_p')
    );
    await flushWaitUntil(waitUntil.mock.calls[0]?.[0] as Promise<unknown>);

    expect(recordCloudAgentSessionAttention).toHaveBeenCalledWith(
      expect.objectContaining({ intent: { kind: 'raise', reason: 'permission' } })
    );
  });

  it('maps a resolve intent to { kind: "resolve" } without a reason', async () => {
    const { deps, recordCloudAgentSessionAttention } = makeDeps();
    const waitUntil = vi.fn((p: Promise<unknown>) => p);

    scheduleCloudAgentAttention({ waitUntil }, deps, makeAttentionEvent('resolve', 'req_r'));
    await flushWaitUntil(waitUntil.mock.calls[0]?.[0] as Promise<unknown>);

    expect(recordCloudAgentSessionAttention).toHaveBeenCalledWith({
      kiloUserId: 'user_1',
      kiloSessionId: 'kilo_1',
      requestId: 'req_r',
      intent: { kind: 'resolve' },
    });
  });

  it('forwards the payload exactly once per call and does not coalesce duplicates', async () => {
    const { deps, recordCloudAgentSessionAttention } = makeDeps();
    const waitUntil = vi.fn((p: Promise<unknown>) => p);

    const event = makeAttentionEvent({ raise: 'question' }, 'req_dup');
    scheduleCloudAgentAttention({ waitUntil }, deps, event);
    scheduleCloudAgentAttention({ waitUntil }, deps, event);
    scheduleCloudAgentAttention({ waitUntil }, deps, event);

    expect(waitUntil).toHaveBeenCalledTimes(3);
    await Promise.all(waitUntil.mock.calls.map(([p]) => flushWaitUntil(p as Promise<unknown>)));
    expect(recordCloudAgentSessionAttention).toHaveBeenCalledTimes(3);
    expect(recordCloudAgentSessionAttention).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        requestId: 'req_dup',
        intent: { kind: 'raise', reason: 'question' },
      })
    );
    expect(recordCloudAgentSessionAttention).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        requestId: 'req_dup',
        intent: { kind: 'raise', reason: 'question' },
      })
    );
  });

  it('is a no-op when metadata is missing and never calls the binding', async () => {
    const { deps, recordCloudAgentSessionAttention } = makeDeps({ metadata: null });
    const waitUntil = vi.fn((p: Promise<unknown>) => p);

    scheduleCloudAgentAttention({ waitUntil }, deps, makeAttentionEvent({ raise: 'question' }));
    await flushWaitUntil(waitUntil.mock.calls[0]?.[0] as Promise<unknown>);

    expect(recordCloudAgentSessionAttention).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('is a no-op when kiloSessionId is missing and never calls the binding', async () => {
    const { deps, recordCloudAgentSessionAttention } = makeDeps({
      metadata: makeMetadata({ kiloSessionId: undefined }),
    });
    const waitUntil = vi.fn((p: Promise<unknown>) => p);

    scheduleCloudAgentAttention({ waitUntil }, deps, makeAttentionEvent({ raise: 'question' }));
    await flushWaitUntil(waitUntil.mock.calls[0]?.[0] as Promise<unknown>);

    expect(recordCloudAgentSessionAttention).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('is a no-op when userId is missing and never calls the binding', async () => {
    const { deps, recordCloudAgentSessionAttention } = makeDeps({
      metadata: makeMetadata({ userId: undefined }),
    });
    const waitUntil = vi.fn((p: Promise<unknown>) => p);

    scheduleCloudAgentAttention({ waitUntil }, deps, makeAttentionEvent({ raise: 'question' }));
    await flushWaitUntil(waitUntil.mock.calls[0]?.[0] as Promise<unknown>);

    expect(recordCloudAgentSessionAttention).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('emits a privacy-safe warn log when the binding throws — no requestId, no reason, no error message', async () => {
    const secretMessage = 'provider-secret-token=abc123 stack=deep';
    const recordCloudAgentSessionAttention = vi
      .fn<RecordAttentionFn>()
      .mockRejectedValue(new Error(`Boom: ${secretMessage}`));
    const { deps } = makeDeps({ recordCloudAgentSessionAttention });
    const waitUntil = vi.fn((p: Promise<unknown>) => p);

    scheduleCloudAgentAttention(
      { waitUntil },
      deps,
      makeAttentionEvent({ raise: 'question' }, 'req_secret')
    );
    await flushWaitUntil(waitUntil.mock.calls[0]?.[0] as Promise<unknown>);

    expect(logger.warn).toHaveBeenCalled();
    const joined = getWarnCalls();
    expect(joined).not.toContain('req_secret');
    expect(joined).not.toContain('question');
    expect(joined).not.toContain('permission');
    expect(joined).not.toContain('resolve');
    expect(joined).not.toContain(secretMessage);
    expect(joined).not.toContain('Boom');
    expect(joined).not.toContain('provider-secret-token');
  });

  it('emits a privacy-safe warn log when the binding returns accepted:false — no requestId or reason', async () => {
    const recordCloudAgentSessionAttention = vi
      .fn<RecordAttentionFn>()
      .mockResolvedValue({ accepted: false, reason: 'deleted' });
    const { deps } = makeDeps({ recordCloudAgentSessionAttention });
    const waitUntil = vi.fn((p: Promise<unknown>) => p);

    scheduleCloudAgentAttention(
      { waitUntil },
      deps,
      makeAttentionEvent({ raise: 'permission' }, 'req_declined')
    );
    await flushWaitUntil(waitUntil.mock.calls[0]?.[0] as Promise<unknown>);

    expect(logger.warn).toHaveBeenCalled();
    const joined = getWarnCalls();
    expect(joined).not.toContain('req_declined');
    expect(joined).not.toContain('permission');
    expect(joined).not.toContain('deleted');
  });

  it('does not throw to the caller when the binding rejects (non-fatal)', async () => {
    const recordCloudAgentSessionAttention = vi
      .fn<RecordAttentionFn>()
      .mockRejectedValue(new Error('upstream gone'));
    const { deps } = makeDeps({ recordCloudAgentSessionAttention });
    const waitUntil = vi.fn((p: Promise<unknown>) => p);

    scheduleCloudAgentAttention({ waitUntil }, deps, makeAttentionEvent({ raise: 'question' }));

    await expect(
      flushWaitUntil(waitUntil.mock.calls[0]?.[0] as Promise<unknown>)
    ).resolves.toBeUndefined();
  });
});
