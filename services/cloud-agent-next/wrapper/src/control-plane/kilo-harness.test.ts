import { describe, expect, it } from 'bun:test';
import type { WrapperKiloClient } from '../kilo-api.js';
import type { Harness } from './harness.js';
import { createKiloHarness, type KiloHarnessOptions } from './kilo-harness.js';

const sessionId = 'ses_harness';
const directory = '/workspace/harness';
const server = { url: 'http://127.0.0.1:1', authorization: 'Basic harness-test' };

function fixture(options: Partial<KiloHarnessOptions> = {}) {
  const prompts: unknown[] = [];
  const commands: unknown[] = [];
  const summaries: unknown[] = [];
  const answers: unknown[] = [];
  const aborts: string[] = [];
  const stops: string[] = [];
  const ensured: string[] = [];
  const seeded: NodeJS.ProcessEnv[] = [];
  const client = {
    server,
    serverUrl: server.url,
    sendPromptAsync: async (input: unknown) => {
      prompts.push(input);
    },
    sendCommand: async (input: unknown) => {
      commands.push(input);
      return { native: true };
    },
    summarizeSession: async (input: unknown) => {
      summaries.push(input);
      return true;
    },
    ensureSession: async (id: string) => {
      ensured.push(id);
    },
    answerPermission: async (...input: unknown[]) => {
      answers.push(input);
      return true;
    },
    answerQuestion: async (...input: unknown[]) => {
      answers.push(input);
      return true;
    },
    rejectQuestion: async (...input: unknown[]) => {
      answers.push(input);
      return true;
    },
    abortSession: async ({ sessionId }: { sessionId: string }) => {
      aborts.push(sessionId);
      return true;
    },
    abortSessionForCleanup: async ({ sessionId }: { sessionId: string }) => {
      aborts.push(sessionId);
    },
    stopSessionProcesses: async ({ sessionId }: { sessionId: string }) => {
      stops.push(sessionId);
    },
    children: async () => [],
    listCommands: async () => ({ commands: [], dropped: 0, overLimit: false }),
    generateCommitMessage: async () => ({ message: 'commit' }),
  } as unknown as WrapperKiloClient;
  const harness = createKiloHarness({
    server,
    directory,
    client,
    seedRegistration: async (_id, env) => {
      seeded.push(env);
    },
    sessionExists: async () => false,
    restore: async () => ({ ok: false, code: 404, error: 'not found', step: 'download' }),
    ...options,
  });
  return { harness, client, prompts, commands, summaries, answers, aborts, stops, ensured, seeded };
}

describe('Kilo harness', () => {
  it('exposes wrapper operations without native server handles or SDK responses', async () => {
    const f = fixture();
    expect('server' in f.harness).toBe(false);
    expect('serverUrl' in f.harness).toBe(false);
    expect('sendPromptAsync' in f.harness).toBe(false);
    expect(await f.harness.command({ sessionId, directory, command: 'review' })).toBeUndefined();
    expect(
      await f.harness.submit({ sessionId, directory, messageId: 'm1', prompt: 'hello' })
    ).toBeUndefined();
    expect(await f.harness.listCommands()).toEqual({ commands: [], dropped: 0, overLimit: false });
    expect(await f.harness.generateCommitMessage({ path: directory })).toEqual({
      message: 'commit',
    });
  });

  it('maps prompt model, agent, variant, parts and cancellation without altering identity', async () => {
    const f = fixture();
    const signal = new AbortController().signal;
    const parts = [{ type: 'file' as const, mime: 'text/plain', url: 'file:///tmp/attachment' }];
    await f.harness.submit({
      sessionId,
      directory,
      messageId: 'm1',
      parts,
      model: 'test/model',
      agent: 'code',
      variant: 'high',
      signal,
    });
    expect(f.prompts).toEqual([
      {
        sessionId,
        directory,
        messageId: 'm1',
        parts,
        model: { providerID: 'kilo', modelID: 'test/model' },
        agent: 'code',
        variant: 'high',
        signal,
      },
    ]);
  });

  it('maps commands and compaction to the pinned native model shape', async () => {
    const f = fixture();
    await f.harness.command({
      sessionId,
      directory,
      command: 'review',
      args: 'main',
      messageId: 'm1',
      model: 'test/model',
    });
    expect(f.commands).toEqual([
      {
        sessionId,
        directory,
        command: 'review',
        args: 'main',
        messageId: 'm1',
        model: { providerID: 'kilo', modelID: 'test/model' },
      },
    ]);
    expect(await f.harness.compact({ sessionId, directory, model: 'test/model', auto: true })).toBe(
      true
    );
    expect(f.summaries).toEqual([
      { sessionId, directory, model: { modelID: 'test/model' }, auto: true },
    ]);
  });

  it('maps answers, rejection and permissions to the owned directory', async () => {
    const f = fixture();
    await f.harness.answer({
      directory,
      reply: { action: 'answer', questionId: 'q1', answers: [['yes']] },
    });
    await f.harness.answer({ directory, reply: { action: 'reject', questionId: 'q2' } });
    await f.harness.answer({
      directory,
      reply: {
        action: 'permission',
        permissionId: 'p1',
        response: 'reject',
        message: 'not allowed',
      },
    });
    expect(f.answers).toEqual([
      ['q1', [['yes']], directory, undefined],
      ['q2', directory, undefined],
      ['p1', 'reject', 'not allowed', undefined, directory, undefined],
    ]);
  });

  it('preserves the native tree-cancellation confirmation', async () => {
    const f = fixture();
    expect(await f.harness.interrupt({ sessionId, directory })).toBe(true);
    f.client.abortSession = async () => false;
    expect(await f.harness.interrupt({ sessionId, directory })).toBe(false);
    expect(f.aborts).toEqual([sessionId]);
  });

  it.each(['once', 'always', 'reject'] as const)(
    'forwards a human %s permission reply and cancellation',
    async response => {
      const f = fixture();
      const signal = new AbortController().signal;
      await f.harness.answer({
        directory,
        interactive: true,
        signal,
        reply: { action: 'permission', permissionId: 'human-required', response },
      });
      expect(f.answers).toEqual([['human-required', response, undefined, true, directory, signal]]);
    }
  );

  it('uses current route credentials rather than a shared runtime environment for open', async () => {
    const f = fixture({ sessionExists: async () => true });
    const first = { KILOCODE_TOKEN: 'first-route' };
    const second = { KILOCODE_TOKEN: 'second-route' };
    await f.harness.open({
      sessionId,
      directory,
      env: first,
      restoreFiles: true,
      onRestore() {
        throw new Error('unexpected restore');
      },
    });
    await f.harness.open({
      sessionId: 'ses_second',
      directory,
      env: second,
      restoreFiles: true,
      onRestore() {
        throw new Error('unexpected restore');
      },
    });
    expect(f.seeded).toEqual([first, second]);
    expect(f.ensured).toEqual([]);
  });

  it('imports missing native history before reporting the session open', async () => {
    const calls: string[] = [];
    const env = { KILOCODE_TOKEN: 'route' };
    const signal = new AbortController().signal;
    const f = fixture({
      restore: async (id, dir, _exec, options) => {
        expect(id).toBe(sessionId);
        expect(dir).toBe(directory);
        expect(options).toMatchObject({ env, signal, restoreFiles: false });
        calls.push('restore');
        return {
          ok: true,
          downloaded: true,
          imported: true,
          diffs: { applied: 0, skipped: 0, total: 0 },
        };
      },
    });
    expect(
      await f.harness.open({
        sessionId,
        directory,
        env,
        signal,
        restoreFiles: false,
        onRestore() {
          calls.push('progress');
        },
      })
    ).toBe(true);
    expect(calls).toEqual(['progress', 'restore']);
    expect(f.ensured).toEqual([]);
  });

  it('creates a session only for missing or empty native history', async () => {
    for (const emptySnapshot of [false, true]) {
      const f = fixture({
        restore: async () => ({
          ok: false,
          code: emptySnapshot ? 200 : 404,
          ...(emptySnapshot ? { emptySnapshot: true as const } : {}),
          error: 'empty',
          step: 'download',
        }),
      });
      expect(
        await f.harness.open({ sessionId, directory, env: {}, restoreFiles: true, onRestore() {} })
      ).toBe(true);
      expect(f.ensured).toEqual([sessionId]);
    }
  });

  it('fails required history restoration rather than silently starting empty', async () => {
    const f = fixture({
      restore: async () => ({ ok: false, code: 503, error: 'unavailable', step: 'download' }),
    });
    const error = await f.harness
      .open({ sessionId, directory, env: {}, restoreFiles: true, onRestore() {} })
      .catch((error: unknown) => error);
    expect(error).toMatchObject({
      message: 'unavailable',
      subtype: 'kilo_import_failed',
      retryable: true,
    });
    expect(f.ensured).toEqual([]);
  });

  it('keeps native observation details behind the observation projection', async () => {
    const input: Parameters<Harness['observe']>[0] = {
      directory,
      observedDirectories: ['/child'],
      knownSessions: [],
      signal: new AbortController().signal,
    };
    const observations = [
      { id: sessionId, directory, status: 'idle' as const, messages: [], interactions: [] },
    ];
    const f = fixture({
      readSnapshot: async request => {
        expect(request).toMatchObject(input);
        return observations;
      },
    });
    expect(await f.harness.observe(input)).toEqual(observations);
  });

  it('bounds release cleanup, avoids cycles and never cleans a foreign directory', async () => {
    const f = fixture();
    f.client.children = async ({ sessionId: id }) =>
      id === sessionId
        ? [
            { id: 'child', directory },
            { id: 'foreign', directory: '/foreign' },
          ]
        : [{ id: sessionId, directory }];
    const result = await f.harness.release({
      sessionId,
      directory,
      signal: new AbortController().signal,
      deadlineMs: 1000,
    });
    expect(result).toMatchObject({ ok: true, sessions: 2, failures: 0 });
    expect(f.aborts).toEqual([sessionId, 'child']);
    expect(f.stops).toEqual([sessionId, 'child']);
  });

  it('retries cleanup once and bounds a hung native request', async () => {
    const f = fixture();
    let attempts = 0;
    f.client.abortSessionForCleanup = async () => {
      if (++attempts === 1) throw new Error('retry');
    };
    expect(
      await f.harness.release({
        sessionId,
        directory,
        signal: new AbortController().signal,
        deadlineMs: 1000,
      })
    ).toMatchObject({ ok: true, failures: 0 });
    expect(attempts).toBe(2);
    f.client.abortSessionForCleanup = () => new Promise(() => undefined);
    expect(
      await f.harness.release({
        sessionId,
        directory,
        signal: new AbortController().signal,
        deadlineMs: 10,
      })
    ).toMatchObject({ ok: false, sessions: 1 });
  });

  it('authenticates native probes without publishing the server credential', async () => {
    const authorization = 'Basic private-test';
    const requests: string[] = [];
    const native = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        expect(request.headers.get('authorization')).toBe(authorization);
        const url = new URL(request.url);
        expect(url.searchParams.get('directory')).toBe(directory);
        requests.push(url.pathname);
        return Response.json(url.pathname === '/pty' ? [] : { id: sessionId });
      },
    });
    try {
      const harness = createKiloHarness({
        server: { url: native.url.toString(), authorization },
        directory,
        seedRegistration: async () => undefined,
      });
      expect(
        await harness.open({
          sessionId,
          directory,
          env: {},
          restoreFiles: true,
          onRestore() {
            throw new Error('unexpected restore');
          },
        })
      ).toBe(true);
      expect(await harness.terminals.isIdle(directory, AbortSignal.timeout(1000))).toBe(true);
      expect(requests).toEqual([`/session/${sessionId}`, '/pty']);
      expect('server' in harness).toBe(false);
    } finally {
      await native.stop(true);
    }
  });

  it('classifies unavailable transports without treating application failures as native loss', () => {
    const f = fixture();
    expect(f.harness.isUnavailableError(new Error('fetch failed'))).toBe(true);
    expect(
      f.harness.isUnavailableError(
        new Error('native failure', { cause: { message: 'fetch failed' } })
      )
    ).toBe(false);
  });
});
