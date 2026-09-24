import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const orchestrationMocks = vi.hoisted(() => ({
  eventQueries: vi.fn(),
  signedAttachments: vi.fn(),
}));

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(
      protected ctx: unknown,
      protected env: unknown
    ) {}
  },
}));
vi.mock('@cloudflare/sandbox', () => ({ getSandbox: vi.fn() }));
vi.mock('drizzle-orm/durable-sqlite', () => ({ drizzle: vi.fn() }));
vi.mock('drizzle-orm/durable-sqlite/migrator', () => ({ migrate: vi.fn(async () => undefined) }));
vi.mock('../../drizzle/migrations', () => ({ default: {} }));
vi.mock('../session/queries/index.js', () => ({
  createEventQueries: orchestrationMocks.eventQueries,
}));
vi.mock('../model-validation.js', () => ({
  assertKiloModelAvailable: vi.fn(async () => undefined),
}));
vi.mock('../execution/attachment-prompt-parts.js', () => ({
  buildSignedPromptAttachments: orchestrationMocks.signedAttachments,
}));
vi.mock('../websocket/stream.js', () => ({
  createStreamHandler: () => ({
    broadcastEvent: vi.fn(),
    handleStreamRequest: async () => Response.json({}),
  }),
}));
// `crypto.subtle.digest` resumes outside Vitest's fake-timer async context, so a
// container-provider warm-base resolution would swap the fake clock for the real
// one mid-delivery. The digest value is irrelevant here; warm-base.test.ts owns
// its correctness.
vi.mock('../utils/sha256.js', () => ({
  sha256Hex: vi.fn(async (value: string) => {
    let hash = 0;
    for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return hash.toString(16).padStart(64, '0');
  }),
}));

import {
  DIRECTORY,
  RUNTIME_ID,
  SANDBOX_ID,
  controlResponse,
  createSessionFixture,
  delegateRequest,
  type SessionFixtureDeps,
} from './session-fixture.test-helpers.js';
import {
  sessionAttachPayloadSchema,
  type SessionOperationDelivery,
} from '../shared/sandbox-control-protocol.js';

const fixtureDeps: SessionFixtureDeps = {
  eventQueries: orchestrationMocks.eventQueries,
  signedAttachments: orchestrationMocks.signedAttachments,
};

const ATTACHED_SESSION_KEY = 'terminal_attached_session';

describe('warm restore acknowledgement gate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  function pendingFixture() {
    const fixture = createSessionFixture(fixtureDeps, {
      workspace: {
        sandboxId: SANDBOX_ID,
        workspacePath: DIRECTORY,
        sandboxProvider: 'cloudflare-containers',
      },
    });
    fixture.setStatus({
      physical: 'running',
      connection: 'ready',
      wrapperInstanceId: RUNTIME_ID,
      allocationIncarnation: 'incarnation_1',
      operationResults: true,
      restoredWorkspace: true,
    });
    fixture.containers.warmBaseFacts.mockResolvedValue({
      image: 'registry.example/kilo/app:test',
      sessionSnapshotId: null,
      hasRecord: true,
      warmRestorePending: true,
    });
    delegateRequest(fixture, 'session.attach', async input => {
      expect(sessionAttachPayloadSchema.parse(input.payload).restoredFromBackup).toBe(true);
      return controlResponse({ attached: true, bootstrapped: true });
    });
    return fixture;
  }

  function completedAttachLookup(fixture: ReturnType<typeof pendingFixture>) {
    delegateRequest(fixture, 'session.operation.get', async input => {
      const authorization = fixture.record('a')?.proofs?.attach?.authorization;
      if (!authorization) throw new Error('Missing attach authorization');
      const delivery: SessionOperationDelivery = {
        version: 2,
        authorization,
        completedAt: Date.now(),
        result: { ok: true, result: { attached: true, bootstrapped: true } },
        events: [],
        preparing: [],
      };
      expect(input.operation).toBe('session.operation.get');
      return controlResponse({ state: 'completed', delivery });
    });
  }

  it('retries the delivery without recording the prepared binding, then succeeds on the next drain', async () => {
    const fixture = pendingFixture();
    fixture.containers.clearWarmRestorePending.mockRejectedValueOnce(
      new Error('storage unavailable')
    );
    completedAttachLookup(fixture);

    await fixture.admit('a');
    await fixture.flush();

    // First drain: the wrapper bootstrapped but the clear failed. The message
    // stays queued with one attach failure; the prepared binding is not written,
    // the prompt is not sent, and a retry is armed.
    expect(fixture.record('a')).toMatchObject({
      state: { kind: 'queued', attachFailures: 1 },
    });
    expect(fixture.values.get(ATTACHED_SESSION_KEY)).toMatchObject({ prepared: false });
    expect(
      fixture.control.request.mock.calls.filter(([input]) => input.operation === 'session.prompt')
    ).toHaveLength(0);
    expect(fixture.alarmAt()).not.toBeNull();

    const retryAt = fixture.alarmAt();
    if (retryAt === null) throw new Error('Missing retry alarm');
    vi.setSystemTime(retryAt);
    await fixture.fireAlarm();
    await fixture.flush();

    // Second drain: the completed attach receipt is reconciled without another
    // wrapper attach, the clear succeeds, and the prompt is finally sent.
    expect(
      fixture.control.request.mock.calls.filter(([input]) => input.operation === 'session.attach')
    ).toHaveLength(1);
    expect(fixture.containers.clearWarmRestorePending).toHaveBeenCalledTimes(2);
    expect(fixture.containers.clearWarmRestorePending.mock.results[1]).toMatchObject({
      type: 'return',
    });
    expect(
      (fixture.values.get(ATTACHED_SESSION_KEY) as { prepared?: boolean } | undefined)?.prepared
    ).toBeUndefined();
    expect(
      fixture.control.request.mock.calls.filter(([input]) => input.operation === 'session.prompt')
    ).toHaveLength(1);
  });

  it('fails the delivery with attach_exhausted, not environment_failed, when the count is spent', async () => {
    const fixture = pendingFixture();
    fixture.containers.clearWarmRestorePending.mockRejectedValue(new Error('storage unavailable'));
    completedAttachLookup(fixture);

    await fixture.admit('a');
    await fixture.flush();
    expect(fixture.record('a')).toMatchObject({
      state: { kind: 'queued', attachFailures: 1 },
    });

    const retryAt = fixture.alarmAt();
    if (retryAt === null) throw new Error('Missing retry alarm');
    vi.setSystemTime(retryAt);
    await fixture.fireAlarm();
    await fixture.flush();

    expect(fixture.record('a')).toMatchObject({
      state: { kind: 'failed', reason: 'attach_exhausted' },
    });
    expect(
      fixture.control.request.mock.calls.filter(([input]) => input.operation === 'session.prompt')
    ).toHaveLength(0);
  });

  it.each(['cloudflare', 'vercel'] as const)(
    'never reads the container record for the %s provider',
    async provider => {
      const fixture = createSessionFixture(fixtureDeps, {
        workspace: { sandboxId: SANDBOX_ID, workspacePath: DIRECTORY, sandboxProvider: provider },
      });
      fixture.setStatus({
        physical: 'running',
        connection: 'ready',
        wrapperInstanceId: RUNTIME_ID,
        allocationIncarnation: 'incarnation_1',
      });
      fixture.containers.warmBaseFacts.mockImplementation(() => {
        throw new Error('container facts must not be read');
      });
      fixture.containers.clearWarmRestorePending.mockImplementation(() => {
        throw new Error('the pending bit must not be cleared');
      });
      delegateRequest(fixture, 'session.attach', async input => {
        expect(sessionAttachPayloadSchema.parse(input.payload).restoredFromBackup).toBeUndefined();
        return controlResponse({ attached: true, bootstrapped: true });
      });

      await fixture.admit('a');
      await fixture.flush();

      expect(fixture.containers.warmBaseFacts).not.toHaveBeenCalled();
      expect(fixture.containers.clearWarmRestorePending).not.toHaveBeenCalled();
      expect(fixture.record('a')).toMatchObject({ state: { kind: 'accepted' } });
      expect(
        fixture.control.request.mock.calls.filter(([input]) => input.operation === 'session.prompt')
      ).toHaveLength(1);
    }
  );
});
