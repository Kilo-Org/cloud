import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ControlPlaneKiloRequestFrame,
  ControlPlaneWrapperFrame,
} from '../../../src/shared/control-plane-protocol.js';
import {
  createControlPlaneKiloRequests,
  type ControlPlaneKiloRequestsDeps,
} from './kilo-requests.js';
import type { WrapperKiloClient } from '../kilo-api.js';
import type { WorktreeSnapshotCapture } from '../../../src/shared/worktree-changes-wire.js';
import {
  fenceDirectoryOperations,
  resetDirectoryOperationState,
} from '../control/worktree-operations.js';

const SESSION_ID = 'workspace_11111111-1111-4111-8111-111111111111';
const KILO_SESSION_ID = 'ses_12345678901234567890123456';
const DIRECTORY = '/workspace/private/root';

function frame(operation: ControlPlaneKiloRequestFrame['operation']): ControlPlaneKiloRequestFrame {
  return {
    type: 'kilo.request',
    requestId: 'req_1',
    session: { sessionId: SESSION_ID, kiloSessionId: KILO_SESSION_ID, directory: DIRECTORY },
    operation,
  };
}

function client(overrides: Partial<WrapperKiloClient> = {}): WrapperKiloClient {
  return {
    getSessionDetails: mock(async () => ({ id: KILO_SESSION_ID })),
    getRecentSessionMessages: mock(async () => []),
    getSessionStatuses: mock(async () => ({})),
    getQuestions: mock(async () => []),
    getPermissions: mock(async () => []),
    getSessionTodos: mock(async () => []),
    getSessionDiff: mock(async () => []),
    ...overrides,
  } as unknown as WrapperKiloClient;
}

function harness(
  nativeClient: WrapperKiloClient | null,
  route = true,
  directory = DIRECTORY,
  overrides: Partial<ControlPlaneKiloRequestsDeps> = {}
) {
  const emitted: ControlPlaneWrapperFrame[] = [];
  const handler = createControlPlaneKiloRequests({
    emit: emittedFrame => emitted.push(emittedFrame),
    preparedRoute: () => (route ? { runtimeKey: 'runtime_1', directory } : null),
    clientFor: () => nativeClient,
    ...overrides,
  });
  return { emitted, handler };
}

describe('control-plane native reads', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    resetDirectoryOperationState();
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map(directory => rm(directory, { recursive: true, force: true }))
    );
  });

  async function repository() {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'native-diff-')));
    temporaryDirectories.push(directory);
    const env = {
      PATH: process.env.PATH,
      HOME: directory,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
      GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
    };
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: directory, env, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    await writeFile(join(directory, '.gitignore'), 'ignored.txt\n');
    await writeFile(join(directory, 'modified.txt'), 'before\n');
    await writeFile(join(directory, 'deleted.txt'), 'deleted\n');
    git('add', '.');
    git('-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'Initial');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    return { directory, git };
  }

  function snapshot(
    reason?: 'binary' | 'too_large' | 'inconsistent',
    truncated = false
  ): WorktreeSnapshotCapture {
    return {
      summary: {
        revision: 1,
        comparison: { baseRef: 'main', mergeBase: 'a'.repeat(40), head: 'b'.repeat(40) },
        files: [
          {
            path: 'file.txt',
            status: 'added',
            additions: 1,
            deletions: 0,
            tracked: false,
            binary: reason === 'binary',
            countsComplete: reason !== 'binary',
          },
        ],
        truncated,
      },
      files: [
        {
          schemaVersion: 1,
          revision: 1,
          path: 'file.txt',
          diff: reason
            ? { status: 'omitted', reason }
            : { status: 'available', patch: 'diff --git a/file.txt b/file.txt\n+actual\n' },
          content: { status: 'unavailable', reason: 'budget_exhausted' },
        },
      ],
    };
  }

  it('reads the requested native session through the prepared runtime', async () => {
    const nativeClient = client();
    const { emitted, handler } = harness(nativeClient);
    await handler.handle(frame({ name: 'session.todo' }));
    expect(nativeClient.getSessionTodos).toHaveBeenCalledWith(
      KILO_SESSION_ID,
      DIRECTORY,
      expect.anything()
    );
    expect(emitted).toEqual([{ type: 'kilo.result', requestId: 'req_1', ok: true, result: [] }]);
  });

  it('scopes pending questions to the requested session', async () => {
    const nativeClient = client({
      getQuestions: mock(async () => [
        { id: 'q1', sessionID: KILO_SESSION_ID },
        { id: 'q2', sessionID: 'ses_sibling_session_identifier_0' },
      ]) as never,
    });
    const { emitted, handler } = harness(nativeClient);
    await handler.handle(frame({ name: 'question.list' }));
    expect(emitted).toEqual([
      {
        type: 'kilo.result',
        requestId: 'req_1',
        ok: true,
        result: [{ id: 'q1', sessionID: KILO_SESSION_ID }],
      },
    ]);
  });

  it('returns the selected status in the native map shape without sibling IDs', async () => {
    const status = { type: 'retry', attempt: 2, message: 'retrying', next: 10 };
    const { emitted, handler } = harness(
      client({
        getSessionStatuses: mock(async () => ({
          [KILO_SESSION_ID]: status,
          ses_sibling: { type: 'busy' },
        })),
      })
    );
    await handler.handle(frame({ name: 'session.status' }));
    expect(emitted).toEqual([
      { type: 'kilo.result', requestId: 'req_1', ok: true, result: { [KILO_SESSION_ID]: status } },
    ]);
  });

  it('returns an empty native status map when only a sibling is active', async () => {
    const { emitted, handler } = harness(
      client({ getSessionStatuses: mock(async () => ({ ses_sibling: { type: 'busy' } })) })
    );
    await handler.handle(frame({ name: 'session.status' }));
    expect(emitted).toEqual([{ type: 'kilo.result', requestId: 'req_1', ok: true, result: {} }]);
  });

  it('preserves a nonempty native patch diff without capturing the worktree', async () => {
    const nativeDiff = [
      {
        file: 'native.txt',
        patch: '+native\n',
        additions: 1,
        deletions: 0,
        status: 'added' as const,
      },
    ];
    const captureSnapshot = mock(async () => snapshot());
    const { emitted, handler } = harness(
      client({ getSessionDiff: mock(async () => nativeDiff) }),
      true,
      DIRECTORY,
      { captureSnapshot }
    );
    await handler.handle(frame({ name: 'session.diff' }));
    expect(emitted[0]).toMatchObject({ ok: true, result: nativeDiff });
    expect(captureSnapshot).not.toHaveBeenCalled();
  });

  it('returns real modified, deleted and untracked patches after native diff returns empty', async () => {
    const { directory, git } = await repository();
    await writeFile(join(directory, 'modified.txt'), 'after\n');
    await rm(join(directory, 'deleted.txt'));
    await writeFile(join(directory, 'added.txt'), 'actual new file\n');
    await writeFile(join(directory, 'ignored.txt'), 'ignored\n');
    const indexBefore = git('ls-files', '--stage');
    const nativeClient = client();
    const { emitted, handler } = harness(nativeClient, true, directory);
    const request = frame({ name: 'session.diff' });
    request.session.directory = directory;
    await handler.handle(request);
    const result = emitted[0];
    if (result.type !== 'kilo.result' || !result.ok || !Array.isArray(result.result))
      throw new Error(`Expected diff array: ${JSON.stringify(result)}`);
    expect(emitted).toHaveLength(1);
    expect(result.result).toHaveLength(3);
    expect(JSON.stringify(result.result)).not.toContain(directory);
    expect(git('ls-files', '--stage')).toBe(indexBefore);
    expect(result.result).toEqual(
      expect.arrayContaining([
        {
          file: 'modified.txt',
          status: 'modified',
          additions: 1,
          deletions: 1,
          patch: expect.stringContaining('-before\n+after\n'),
        },
        {
          file: 'deleted.txt',
          status: 'deleted',
          additions: 0,
          deletions: 1,
          patch: expect.stringContaining('-deleted\n'),
        },
        {
          file: 'added.txt',
          status: 'added',
          additions: 1,
          deletions: 0,
          patch: expect.stringContaining('+actual new file\n'),
        },
      ])
    );
    expect(nativeClient.getSessionDiff).toHaveBeenCalledWith(
      KILO_SESSION_ID,
      directory,
      expect.anything()
    );
  });

  it('includes committed turn changes against the explicitly selected upstream base', async () => {
    const { directory, git } = await repository();
    await writeFile(join(directory, 'upstream.txt'), 'upstream\n');
    git('add', '.');
    git('-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'Upstream');
    git('update-ref', 'refs/remotes/origin/feature', 'HEAD');
    await writeFile(join(directory, 'turn.txt'), 'committed turn\n');
    git('add', '.');
    git('-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'Turn');
    const request = frame({ name: 'session.diff', baseRef: 'refs/remotes/origin/feature' });
    request.session.directory = directory;
    const { emitted, handler } = harness(client(), true, directory);
    await handler.handle(request);
    expect(emitted[0]).toMatchObject({
      ok: true,
      result: [
        {
          file: 'turn.txt',
          status: 'added',
          additions: 1,
          deletions: 0,
          patch: expect.stringContaining('+committed turn\n'),
        },
      ],
    });
    expect(git('status', '--porcelain')).toBe('');
  });

  it('returns a genuinely empty diff for a clean real repository', async () => {
    const { directory } = await repository();
    const request = frame({ name: 'session.diff' });
    request.session.directory = directory;
    const { emitted, handler } = harness(client(), true, directory);
    await handler.handle(request);
    expect(emitted[0]).toMatchObject({ ok: true, result: [] });
  });

  it('reports a real oversized patch instead of silently omitting it', async () => {
    const { directory } = await repository();
    await writeFile(join(directory, 'large.txt'), 'line\n'.repeat(10_001));
    const request = frame({ name: 'session.diff' });
    request.session.directory = directory;
    const { emitted, handler } = harness(client(), true, directory);
    await handler.handle(request);
    expect(emitted[0]).toMatchObject({ ok: false, error: { code: 'too_large', retryable: false } });
  });

  it('rejects symlink file capture rather than reading outside the worktree', async () => {
    const { directory } = await repository();
    await symlink('/etc/passwd', join(directory, 'outside.txt'));
    const request = frame({ name: 'session.diff' });
    request.session.directory = directory;
    const { emitted, handler } = harness(client(), true, directory);
    await handler.handle(request);
    expect(emitted[0]).toMatchObject({ ok: false, error: { code: 'native_failed' } });
  });

  it.each([
    { reason: 'too_large' as const, truncated: false },
    { reason: undefined, truncated: true },
  ])(
    'reports too_large instead of returning a truncated diff: %j',
    async ({ reason, truncated }) => {
      const { emitted, handler } = harness(client(), true, DIRECTORY, {
        captureSnapshot: async () => snapshot(reason, truncated),
      });
      await handler.handle(frame({ name: 'session.diff' }));
      expect(emitted[0]).toMatchObject({
        ok: false,
        error: { code: 'too_large', retryable: false },
      });
    }
  );

  it('represents binary changes with the native empty-patch shape', async () => {
    const { directory } = await repository();
    await writeFile(join(directory, 'binary.dat'), Buffer.from([0, 1, 2]));
    const request = frame({ name: 'session.diff' });
    request.session.directory = directory;
    const { emitted, handler } = harness(client(), true, directory);
    await handler.handle(request);
    expect(emitted[0]).toMatchObject({
      ok: true,
      result: [{ file: 'binary.dat', status: 'added', additions: 0, deletions: 0, patch: '' }],
    });
  });

  it('does not hide a native failure or malformed response with worktree changes', async () => {
    const captureSnapshot = mock(async () => snapshot());
    for (const getSessionDiff of [
      mock(async () => {
        throw new Error('Native failure');
      }),
      mock(async () => ({})) as never,
    ]) {
      const { emitted, handler } = harness(client({ getSessionDiff }), true, DIRECTORY, {
        captureSnapshot,
      });
      await handler.handle(frame({ name: 'session.diff' }));
      expect(emitted[0]).toMatchObject({ ok: false, error: { code: 'native_failed' } });
    }
    expect(captureSnapshot).not.toHaveBeenCalled();
  });

  it('cancels fallback capture using the native request deadline', async () => {
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const timeout = spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    try {
      const { emitted, handler } = harness(client(), true, DIRECTORY, {
        timeoutMs: 10,
        captureSnapshot: (_directory, _payload, signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            started.resolve();
          }),
      });
      const pending = handler.handle(frame({ name: 'session.diff' }));
      await started.promise;
      controller.abort(new Error('Request deadline elapsed'));
      await pending;
      expect(timeout).toHaveBeenCalledWith(10);
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({ ok: false, error: { code: 'timeout', retryable: true } });
    } finally {
      timeout.mockRestore();
    }
  });

  it('rejects an oversized native diff without truncation or fallback', async () => {
    const captureSnapshot = mock(async () => snapshot());
    const nativeClient = client({
      getSessionDiff: mock(async () => [
        {
          file: 'large.txt',
          additions: 1,
          deletions: 0,
          patch: 'x'.repeat(8 * 1024 * 1024),
        },
      ]),
    });
    const { emitted, handler } = harness(nativeClient, true, DIRECTORY, { captureSnapshot });
    await handler.handle(frame({ name: 'session.diff' }));
    expect(emitted[0]).toMatchObject({ ok: false, error: { code: 'too_large', retryable: false } });
    expect(captureSnapshot).not.toHaveBeenCalled();
  });

  it('does not capture when a route or native runtime is unavailable', async () => {
    const captureSnapshot = mock(async () => snapshot());
    for (const [nativeClient, route] of [
      [client(), false],
      [null, true],
    ] as const) {
      const { emitted, handler } = harness(nativeClient, route, DIRECTORY, { captureSnapshot });
      await handler.handle(frame({ name: 'session.diff' }));
      expect(emitted[0]).toMatchObject({ ok: false, error: { code: 'not_ready' } });
    }
    expect(captureSnapshot).not.toHaveBeenCalled();
  });

  it('fences fallback capture against worktree deletion', async () => {
    const captureSnapshot = mock(async () => snapshot());
    await fenceDirectoryOperations(DIRECTORY);
    const { emitted, handler } = harness(client(), true, DIRECTORY, { captureSnapshot });
    await handler.handle(frame({ name: 'session.diff' }));
    expect(emitted[0]).toMatchObject({ ok: false, error: { code: 'not_ready' } });
    expect(captureSnapshot).not.toHaveBeenCalled();
  });

  it('refuses a route that is not prepared instead of starting one', async () => {
    const { emitted, handler } = harness(client(), false);
    await handler.handle(frame({ name: 'session.get' }));
    expect(emitted).toEqual([
      {
        type: 'kilo.result',
        requestId: 'req_1',
        ok: false,
        error: {
          code: 'not_ready',
          message: 'Session directory is not attached',
          retryable: false,
        },
      },
    ]);
  });

  it('always answers exactly once when the native client fails', async () => {
    const { emitted, handler } = harness(
      client({ getSessionStatuses: mock(async () => Promise.reject(new Error('boom'))) as never })
    );
    await handler.handle(frame({ name: 'session.status' }));
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ type: 'kilo.result', ok: false });
  });

  it('bounds a message window to the requested limit', async () => {
    const messages = Array.from({ length: 5 }, (_, index) => ({ info: { id: `m${index}` } }));
    const nativeClient = client({
      getRecentSessionMessages: mock(async () => messages) as never,
    });
    const { emitted, handler } = harness(nativeClient);
    await handler.handle(frame({ name: 'session.messages', limit: 2 }));
    expect(emitted[0]).toMatchObject({
      ok: true,
      result: [{ info: { id: 'm3' } }, { info: { id: 'm4' } }],
    });
  });
});
