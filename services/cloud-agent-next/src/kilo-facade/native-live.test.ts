import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class DurableObject {
    ctx: unknown;
    env: unknown;

    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

const { getSandboxSessionStubMock, withDORetryMock } = vi.hoisted(() => ({
  getSandboxSessionStubMock: vi.fn(),
  withDORetryMock: vi.fn(),
}));

vi.mock('../sandbox-session/session-stub.js', () => ({
  getSandboxSessionStub: getSandboxSessionStubMock,
  resolveLegacySessionStub: vi.fn(),
}));

vi.mock('../utils/do-retry.js', () => ({
  withDORetry: withDORetryMock,
}));

import type { ControlPlaneNativeOperation } from '../shared/control-plane-protocol.js';
import {
  defaultNativeLiveReader,
  readNativeLiveOperation,
  type NativeLiveReader,
} from './native-live.js';
import { publicCloudAgentDirectory } from './public-sdk-projection.js';

const kiloSessionId = 'ses_12345678901234567890123456';
const cloudAgentSessionId = 'workspace_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function readParams(operation: ControlPlaneNativeOperation, read: NativeLiveReader) {
  return {
    env: {} as never,
    userId: 'usr_1',
    cloudAgentSessionId,
    kiloSessionId,
    operation,
    read,
  };
}

describe('readNativeLiveOperation', () => {
  it('returns the native todo list without exposing sandbox paths', async () => {
    const outcome = await readNativeLiveOperation(
      readParams({ name: 'session.todo' }, async () => ({
        ok: true,
        result: [{ content: 'Ship it', status: 'in_progress', priority: 'high' }],
      }))
    );
    expect(outcome).toEqual({
      kind: 'ok',
      body: [{ content: 'Ship it', status: 'in_progress', priority: 'high' }],
    });
  });

  it('reports a stopped runtime as not_ready instead of proxying anywhere', async () => {
    const read = vi.fn(async () => ({
      ok: false as const,
      error: { code: 'not_ready', message: 'Live runtime is not ready', retryable: true },
    }));
    const outcome = await readNativeLiveOperation(readParams({ name: 'session.status' }, read));
    expect(outcome).toEqual({ kind: 'not_ready', message: 'Live runtime is not ready' });
  });

  it('maps a session status read for a sibling session without leaking its directory', async () => {
    const outcome = await readNativeLiveOperation(
      readParams({ name: 'session.status' }, async () => ({
        ok: true,
        result: { [kiloSessionId]: { type: 'busy', directory: '/workspace/private' } },
      }))
    );
    expect(outcome).toEqual({ kind: 'ok', body: { [kiloSessionId]: { type: 'busy' } } });
  });

  it('rejects a native session detail that names a different session', async () => {
    const outcome = await readNativeLiveOperation(
      readParams({ name: 'session.get' }, async () => ({
        ok: true,
        result: { id: 'ses_ffffffffffffffffffffffffff', directory: '/workspace/private' },
      }))
    );
    expect(outcome).toMatchObject({ kind: 'failed', code: 'KILO_UPSTREAM_RESPONSE_INVALID' });
  });

  it('projects a live session detail onto the public directory', async () => {
    const outcome = await readNativeLiveOperation(
      readParams({ name: 'session.get' }, async () => ({
        ok: true,
        result: { id: kiloSessionId, directory: '/workspace/private/root', title: 'Hosted' },
      }))
    );
    expect(outcome).toMatchObject({
      kind: 'ok',
      body: {
        id: kiloSessionId,
        directory: publicCloudAgentDirectory(kiloSessionId),
        title: 'Hosted',
      },
    });
  });

  it('bounds a message window to the requested limit', async () => {
    const messages = Array.from({ length: 5 }, (_, index) => ({
      info: { id: `msg_${index}` },
      parts: [],
    }));
    const outcome = await readNativeLiveOperation(
      readParams({ name: 'session.messages', limit: 2 }, async () => ({
        ok: true,
        result: messages,
      }))
    );
    expect(outcome).toMatchObject({ kind: 'ok' });
    if (outcome.kind !== 'ok') throw new Error('expected ok');
    expect((outcome.body as Array<{ info: { id: string } }>).map(item => item.info.id)).toEqual([
      'msg_3',
      'msg_4',
    ]);
  });

  it('reports a too-large native response as too_large', async () => {
    const outcome = await readNativeLiveOperation(
      readParams({ name: 'session.diff' }, async () => ({
        ok: false as const,
        error: { code: 'too_large', message: 'too large', retryable: false },
      }))
    );
    expect(outcome).toEqual({ kind: 'too_large' });
  });

  it('reports a transport failure as a retryable live-runtime error', async () => {
    const outcome = await readNativeLiveOperation(
      readParams({ name: 'question.list' }, async () => {
        throw new Error('socket closed');
      })
    );
    expect(outcome).toEqual({
      kind: 'failed',
      code: 'KILO_LIVE_RUNTIME_UNAVAILABLE',
      message: 'Cloud Agent Kilo runtime is not live',
      retryable: true,
    });
  });

  it('reads through the Session DO and never prepares a sandbox', async () => {
    const kiloRequest = vi.fn(async (operation: ControlPlaneNativeOperation) => ({
      operation,
      ok: true as const,
      result: [{ id: 'que_1', sessionID: kiloSessionId }],
    }));
    withDORetryMock.mockImplementation(async (_stub: unknown, run: (stub: unknown) => unknown) =>
      run({ kiloRequest })
    );
    getSandboxSessionStubMock.mockReturnValue({ kiloRequest });
    const read = defaultNativeLiveReader({
      env: {} as never,
      userId: 'usr_1',
      cloudAgentSessionId,
    });
    const result = await read({ name: 'question.list' });
    expect(result).toMatchObject({ ok: true });
    expect(kiloRequest).toHaveBeenCalledWith({ name: 'question.list' });
    expect(kiloRequest).toHaveBeenCalledTimes(1);
  });
});

describe('native todo and diff shapes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps todo rows strict', async () => {
    const outcome = await readNativeLiveOperation(
      readParams({ name: 'session.todo' }, async () => ({
        ok: true,
        result: [{ content: 'x', status: 'pending', priority: 'low', extra: true }],
      }))
    );
    expect(outcome).toMatchObject({ kind: 'failed', code: 'KILO_UPSTREAM_RESPONSE_INVALID' });
  });

  it('keeps diff file entries and drops private path fields', async () => {
    const outcome = await readNativeLiveOperation(
      readParams({ name: 'session.diff' }, async () => ({
        ok: true,
        result: [{ file: 'src/app.ts', additions: 2, deletions: 1, before: '/tmp/a.ts' }],
      }))
    );
    expect(outcome).toEqual({
      kind: 'ok',
      body: [{ file: 'src/app.ts', additions: 2, deletions: 1 }],
    });
  });
});
