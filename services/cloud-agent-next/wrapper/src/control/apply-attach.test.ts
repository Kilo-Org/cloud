import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, spyOn } from 'bun:test';
import { applySessionAttach as applyAttach } from './apply-attach';
import { KILO_CONTROL_REQUEST_TIMEOUT_MS } from './sandbox-control-runtime';
import { runProcess } from '../utils';
import type { WrapperKiloClient } from '../kilo-api';
import type { PreparingEventDataV2 } from '../../../src/shared/protocol.js';
import { CONTROL_RUNTIME_RESERVED_ENV_VARS } from '../../../src/shared/runtime-environment.js';
import { sessionPreparingPayloadSchema } from '../../../src/shared/sandbox-control-protocol';

const session = {
  sessionId: 'workspace_1',
  kiloSessionId: 'kilo_1',
  directory: '/workspace/a',
};

function fakeKilo(overrides: Partial<WrapperKiloClient> = {}): WrapperKiloClient {
  return {
    getSession: async id => ({ id }),
    ensureSession: async () => undefined,
    ...overrides,
  } as WrapperKiloClient;
}

const noFs = {
  hasBootstrapMarker: async () => false,
  writeBootstrapMarker: async () => undefined,
};

function applySessionAttach(
  ...args: Parameters<typeof applyAttach>
): ReturnType<typeof applyAttach> {
  const [session, payload, deps] = args;
  return applyAttach(session, payload, { sessionExists: async () => true, ...deps });
}

describe('applySessionAttach', () => {
  it('reuses setup-only workspaces without writing bootstrap state into their content', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'control-bootstrap-'));
    const directory = path.join(root, 'workspace');
    let setupRuns = 0;
    const deps = {
      kiloClient: fakeKilo(),
      runSetup: async () => {
        setupRuns += 1;
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    };
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(
          await applySessionAttach({ ...session, directory }, { setupCommands: ['true'] }, deps)
        ).toEqual({ ok: true, result: { attached: true } });
      }
      expect(setupRuns).toBe(1);
      expect(await fs.readdir(directory)).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('clones and checks out a non-default branch without mutating process.env', async () => {
    const gitCalls: string[][] = [];
    const mkdirCalls: string[] = [];
    const envBefore = process.env.KILOCODE_TOKEN;
    const result = await applySessionAttach(
      session,
      {
        directory: '/workspace/a',
        branch: 'feature/non-default',
        git: { url: 'https://github.com/acme/demo.git', token: 'secret', platform: 'github' },
        env: { KILOCODE_TOKEN: 'cap_1' },
      },
      {
        kiloClient: fakeKilo(),
        ...noFs,
        mkdir: async directory => {
          mkdirCalls.push(directory);
        },
        hasGit: async () => false,
        runGit: async args => {
          gitCalls.push(args);
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      }
    );
    expect(result).toEqual({ ok: true, result: { attached: true } });
    expect(mkdirCalls).toEqual(['/workspace/a']);
    expect(gitCalls[0]?.[0]).toBe('clone');
    expect(gitCalls[0]?.includes('--branch')).toBe(false);
    expect(gitCalls[1]).toEqual([
      'checkout',
      '-B',
      'feature/non-default',
      'origin/feature/non-default',
    ]);
    expect(gitCalls[0]?.some(arg => arg.includes('secret'))).toBe(true);
    expect(process.env.KILOCODE_TOKEN).toBe(envBefore);
  });

  it('skips clone when the directory already has git metadata', async () => {
    const gitCalls: string[][] = [];
    const result = await applySessionAttach(
      session,
      { git: { url: 'https://github.com/acme/demo.git' } },
      {
        kiloClient: fakeKilo(),
        ...noFs,
        mkdir: async () => undefined,
        hasGit: async () => true,
        runGit: async args => {
          gitCalls.push(args);
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      }
    );
    expect(result.ok).toBe(true);
    expect(gitCalls).toEqual([
      ['config', 'user.name', 'Kilo Code Cloud'],
      ['config', 'user.email', 'agent@kilocode.ai'],
    ]);
  });

  it('checks out the requested branch when the directory already has git metadata', async () => {
    const gitCalls: Array<{ args: string[]; cwd?: string }> = [];
    const result = await applySessionAttach(
      session,
      { branch: 'feature/retry', git: { url: 'https://github.com/acme/demo.git' } },
      {
        kiloClient: fakeKilo(),
        ...noFs,
        mkdir: async () => undefined,
        hasGit: async () => true,
        runGit: async (args, cwd) => {
          gitCalls.push({ args, cwd });
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      }
    );

    expect(result).toEqual({ ok: true, result: { attached: true } });
    expect(gitCalls).toEqual([
      { args: ['checkout', '-B', 'feature/retry', 'origin/feature/retry'], cwd: '/workspace/a' },
      { args: ['config', 'user.name', 'Kilo Code Cloud'], cwd: '/workspace/a' },
      { args: ['config', 'user.email', 'agent@kilocode.ai'], cwd: '/workspace/a' },
    ]);
  });

  it('retries branch checkout after cloning succeeds but the initial checkout fails', async () => {
    const gitCalls: string[][] = [];
    const setupCalls: string[] = [];
    const events: PreparingEventDataV2[] = [];
    let gitExists = false;
    let bootstrapComplete = false;
    let markerWrites = 0;
    let checkoutAttempts = 0;
    const payload = {
      branch: 'feature/retry',
      git: { url: 'https://github.com/acme/demo.git' },
      setupCommands: ['pnpm install'],
      preparation: { attemptId: 'att_1', triggerMessageId: 'msg_1' },
    };
    const deps = {
      kiloClient: fakeKilo(),
      mkdir: async () => undefined,
      hasGit: async () => gitExists,
      hasBootstrapMarker: async () => bootstrapComplete,
      writeBootstrapMarker: async () => {
        markerWrites += 1;
        bootstrapComplete = true;
      },
      runGit: async (args: string[]) => {
        gitCalls.push(args);
        if (args[0] === 'clone') {
          gitExists = true;
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (args[0] !== 'checkout') return { stdout: '', stderr: '', exitCode: 0 };
        checkoutAttempts += 1;
        return {
          stdout: '',
          stderr: checkoutAttempts === 1 ? 'checkout failed' : '',
          exitCode: checkoutAttempts === 1 ? 1 : 0,
        };
      },
      runSetup: async (command: string) => {
        setupCalls.push(command);
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      emitPreparing: (event: PreparingEventDataV2) => {
        events.push(event);
      },
    };

    const failed = await applySessionAttach(session, payload, deps);

    expect(failed).toEqual({
      ok: false,
      error: { code: 'not_ready', message: 'git checkout failed', retryable: true },
    });
    expect(gitExists).toBe(true);
    expect(setupCalls).toEqual([]);
    expect(markerWrites).toBe(0);

    const retried = await applySessionAttach(session, payload, deps);

    expect(retried).toEqual({ ok: true, result: { attached: true } });
    expect(gitCalls).toEqual([
      ['clone', 'https://github.com/acme/demo.git', '/workspace/a'],
      ['checkout', '-B', 'feature/retry', 'origin/feature/retry'],
      ['checkout', '-B', 'feature/retry', 'origin/feature/retry'],
      ['config', 'user.name', 'Kilo Code Cloud'],
      ['config', 'user.email', 'agent@kilocode.ai'],
    ]);
    expect(setupCalls).toEqual(['pnpm install']);
    expect(markerWrites).toBe(1);
    expect(events.filter(event => event.step === 'cloning').map(event => event.action)).toEqual([
      'step_started',
      'step_progress',
      'step_failed',
      'step_started',
      'step_completed',
    ]);
  });

  it('skips clone and setup when the bootstrap marker is present', async () => {
    const gitCalls: string[][] = [];
    const setupCalls: string[] = [];
    const result = await applySessionAttach(
      session,
      {
        git: { url: 'https://github.com/acme/demo.git' },
        setupCommands: ['pnpm install'],
      },
      {
        kiloClient: fakeKilo(),
        hasBootstrapMarker: async () => true,
        writeBootstrapMarker: async () => undefined,
        mkdir: async () => undefined,
        hasGit: async () => false,
        runGit: async args => {
          gitCalls.push(args);
          return { stdout: '', stderr: '', exitCode: 0 };
        },
        runSetup: async command => {
          setupCalls.push(command);
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      }
    );
    expect(result.ok).toBe(true);
    expect(gitCalls).toEqual([]);
    expect(setupCalls).toEqual([]);
  });

  it('runs setup commands and emits preparing steps', async () => {
    const setupCalls: Array<{ command: string; env?: Record<string, string> }> = [];
    const events: PreparingEventDataV2[] = [];
    const result = await applySessionAttach(
      session,
      {
        git: { url: 'https://github.com/acme/demo.git' },
        setupCommands: ['pnpm install'],
        env: { FOO: 'bar' },
        preparation: { attemptId: 'att_1', triggerMessageId: 'msg_1' },
      },
      {
        kiloClient: fakeKilo(),
        ...noFs,
        mkdir: async () => undefined,
        hasGit: async () => false,
        runGit: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
        runSetup: async (command, _directory, env) => {
          setupCalls.push(env ? { command, env } : { command });
          return { stdout: '', stderr: '', exitCode: 0 };
        },
        emitPreparing: event => {
          events.push(event);
        },
      }
    );
    expect(result.ok).toBe(true);
    expect(setupCalls).toEqual([{ command: 'pnpm install', env: { FOO: 'bar' } }]);
    expect(events[0]).toMatchObject({
      action: 'attempt_started',
      attemptId: 'att_1',
      triggerMessageId: 'msg_1',
    });
    expect(events.some(event => event.action === 'step_started' && event.step === 'cloning')).toBe(
      true
    );
    expect(
      events.some(
        event =>
          event.action === 'step_started' &&
          event.step === 'setup_commands' &&
          'command' in event &&
          event.command === 'pnpm install'
      )
    ).toBe(true);
  });

  it('redacts injected auth/config tokens and split setup output before emitting any preparation fields', async () => {
    const env = {
      KILO_AUTH_CONTENT: JSON.stringify({ kilo: { type: 'api', key: 'fake-auth-sentinel-123' } }),
      KILO_CONFIG_CONTENT: JSON.stringify({
        provider: { kilo: { options: { apiKey: 'fake-config-sentinel-456' } } },
      }),
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        provider: {
          kilo: { options: { headers: { Authorization: 'Bearer fake-header-sentinel-789' } } },
        },
      }),
    };
    const events: PreparingEventDataV2[] = [];
    const dump = `${Object.entries(env)
      .map(([name, value]) => `${name}=${value}`)
      .join('\n')}\nextracted: fake-config-sentinel-456\ninstalled packages\n`;
    const result = await applySessionAttach(
      session,
      {
        env,
        setupCommands: ['env; printf fake-config-sentinel-456'],
        preparation: { attemptId: 'attempt_1', triggerMessageId: 'msg_1' },
      },
      {
        ...noFs,
        kiloClient: fakeKilo(),
        mkdir: async () => {},
        emitPreparing: event => events.push(event),
        runSetup: async (_command, _directory, _env, onOutput) => {
          for (let offset = 0; offset < dump.length; offset += 7) {
            onOutput?.('stdout', dump.slice(offset, offset + 7));
            if (offset === 0) onOutput?.('stderr', 'warning fake-auth-');
          }
          onOutput?.('stderr', 'sentinel-123\n');
          return { stdout: dump, stderr: '', exitCode: 0 };
        },
      }
    );
    expect(result).toMatchObject({ ok: true });
    const serialized = JSON.stringify(events);
    for (const token of [
      'fake-auth-sentinel-123',
      'fake-config-sentinel-456',
      'fake-header-sentinel-789',
    ])
      expect(serialized).not.toContain(token);
    expect(serialized).toContain('[REDACTED]');
    expect(serialized).toContain('installed packages');
    expect(events.every(event => sessionPreparingPayloadSchema.safeParse(event).success)).toBe(
      true
    );
  });

  it('fails attach when a setup command fails', async () => {
    const result = await applySessionAttach(
      session,
      { setupCommands: ['false'] },
      {
        kiloClient: fakeKilo(),
        ...noFs,
        mkdir: async () => undefined,
        runSetup: async () => ({ stdout: '', stderr: 'nope', exitCode: 1 }),
      }
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('not_ready');
      expect(result.error.message).toContain('Setup command 1 failed');
    }
  });

  it('attaches when Kilo does not yet have the minted session', async () => {
    const ensured: string[] = [];
    const result = await applySessionAttach(
      session,
      {},
      {
        sessionExists: async () => false,
        kiloClient: fakeKilo({
          ensureSession: async (sessionId, directory) => {
            ensured.push(`${sessionId}:${directory}`);
          },
        }),
        restoreSession: async () => ({
          ok: false,
          error: 'snapshot not found (404)',
          code: 404,
          step: 'download',
        }),
        ...noFs,
      }
    );
    expect(result).toEqual({ ok: true, result: { attached: true } });
    expect(ensured).toEqual(['kilo_1:/workspace/a']);
  });

  it('imports snapshot when Kilo is missing the session', async () => {
    let ensured = false;
    let restoredId: string | undefined;
    const result = await applySessionAttach(
      session,
      {},
      {
        kiloClient: fakeKilo({
          ensureSession: async () => {
            ensured = true;
          },
        }),
        sessionExists: async () => false,
        restoreSession: async kiloSessionId => {
          restoredId = kiloSessionId;
          return {
            ok: true,
            downloaded: true,
            imported: true,
            diffs: { applied: 0, skipped: 0, total: 0 },
          };
        },
        ...noFs,
      }
    );
    expect(result).toEqual({ ok: true, result: { attached: true } });
    expect(restoredId).toBe(session.kiloSessionId);
    expect(ensured).toBe(false);
  });

  it('creates an empty shell when snapshot is 404', async () => {
    const ensured: Array<[string, string]> = [];
    const result = await applySessionAttach(
      session,
      {},
      {
        kiloClient: fakeKilo({
          ensureSession: async (sessionId, directory) => {
            ensured.push([sessionId, directory]);
          },
        }),
        sessionExists: async () => false,
        restoreSession: async () => ({
          ok: false,
          error: 'snapshot not found (404)',
          code: 404,
          step: 'download',
        }),
        ...noFs,
      }
    );
    expect(result).toEqual({ ok: true, result: { attached: true } });
    expect(ensured).toEqual([[session.kiloSessionId, session.directory]]);
  });

  it('creates an empty shell for an explicitly identified empty session export', async () => {
    const ensured: Array<[string, string]> = [];
    const result = await applySessionAttach(
      session,
      {},
      {
        kiloClient: fakeKilo({
          ensureSession: async (sessionId, directory) => {
            ensured.push([sessionId, directory]);
          },
        }),
        sessionExists: async () => false,
        restoreSession: async () => ({
          ok: false,
          error:
            'snapshot missing info.id (42 bytes); session-ingest may have returned an error body',
          code: null,
          step: 'download',
          emptySnapshot: true,
        }),
        ...noFs,
      }
    );

    expect(result).toEqual({ ok: true, result: { attached: true } });
    expect(ensured).toEqual([[session.kiloSessionId, session.directory]]);
  });

  it('fails attach when snapshot metadata is missing without an empty-export marker', async () => {
    let ensured = false;
    const result = await applySessionAttach(
      session,
      {},
      {
        kiloClient: fakeKilo({
          ensureSession: async () => {
            ensured = true;
          },
        }),
        sessionExists: async () => false,
        restoreSession: async () => ({
          ok: false,
          error:
            'snapshot missing info.id (42 bytes); session-ingest may have returned an error body',
          code: null,
          step: 'download',
        }),
        ...noFs,
      }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not_ready');
    expect(ensured).toBe(false);
  });

  it('fails attach when restore fails with a non-404', async () => {
    let ensured = false;
    const result = await applySessionAttach(
      session,
      {},
      {
        kiloClient: fakeKilo({
          ensureSession: async () => {
            ensured = true;
          },
        }),
        sessionExists: async () => false,
        restoreSession: async () => ({
          ok: false,
          error: 'download failed',
          code: 502,
          step: 'download',
        }),
        ...noFs,
      }
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not_ready');
    expect(ensured).toBe(false);
  });

  it('does not restore when Kilo already has the session', async () => {
    let restored = false;
    let ensured = false;
    const result = await applySessionAttach(
      session,
      {},
      {
        kiloClient: fakeKilo({
          ensureSession: async () => {
            ensured = true;
          },
        }),
        sessionExists: async () => true,
        restoreSession: async () => {
          restored = true;
          return {
            ok: true,
            downloaded: true,
            imported: true,
            diffs: { applied: 0, skipped: 0, total: 0 },
          };
        },
        ...noFs,
      }
    );
    expect(result).toEqual({ ok: true, result: { attached: true } });
    expect(restored).toBe(false);
    expect(ensured).toBe(false);
  });

  it('uses snapshotIdentity when present', async () => {
    const ids: string[] = [];
    const result = await applySessionAttach(
      session,
      { snapshotIdentity: 'ses_other' },
      {
        kiloClient: fakeKilo(),
        sessionExists: async kiloSessionId => {
          ids.push(kiloSessionId);
          return false;
        },
        restoreSession: async kiloSessionId => {
          ids.push(kiloSessionId);
          return {
            ok: true,
            downloaded: true,
            imported: true,
            diffs: { applied: 0, skipped: 0, total: 0 },
          };
        },
        ...noFs,
      }
    );
    expect(result).toEqual({ ok: true, result: { attached: true } });
    expect(ids).toEqual(['ses_other', 'ses_other']);
  });

  it('bounds a genuinely hanging session probe without restoring or creating an empty session', async () => {
    const timers = spyOn(globalThis, 'setTimeout');
    const probing = Promise.withResolvers<void>();
    let probeSignal: AbortSignal | undefined;
    let restored = false;
    let ensured = false;
    try {
      const attaching = applySessionAttach(
        session,
        {},
        {
          ...noFs,
          kiloClient: fakeKilo({
            ensureSession: async () => {
              ensured = true;
            },
          }),
          sessionExists: (_id, directory, signal) => {
            expect(directory).toBe(session.directory);
            probeSignal = signal;
            probing.resolve();
            return new Promise<boolean>(() => {});
          },
          restoreSession: async () => {
            restored = true;
            return { ok: false, step: 'download', code: 404, error: 'not found' };
          },
        }
      );
      await probing.promise;
      const deadline = timers.mock.calls.find(
        ([, ms]) => ms === KILO_CONTROL_REQUEST_TIMEOUT_MS
      )?.[0];
      if (typeof deadline !== 'function') throw new Error('missing bounded session probe deadline');
      deadline();
      expect(await attaching).toMatchObject({ ok: false, error: { code: 'not_ready' } });
      expect(probeSignal?.aborted).toBe(true);
      expect(restored).toBe(false);
      expect(ensured).toBe(false);
    } finally {
      timers.mockRestore();
    }
  });

  it('does not turn HTTP 500 from the directory-scoped session probe into a restore attempt', async () => {
    const requests: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        requests.push(request.url);
        return new Response('failure', { status: 500 });
      },
    });
    let restored = false;
    try {
      const result = await applyAttach(
        session,
        {},
        {
          ...noFs,
          kiloClient: fakeKilo({ serverUrl: server.url.toString() }),
          restoreSession: async () => {
            restored = true;
            return { ok: false, step: 'download', code: 404, error: 'not found' };
          },
        }
      );
      expect(result).toMatchObject({ ok: false });
      expect(restored).toBe(false);
      const request = new URL(requests[0] ?? '');
      expect(request.pathname).toBe('/session/kilo_1');
      expect(request.searchParams.get('directory')).toBe(session.directory);
    } finally {
      await server.stop(true);
    }
  });

  it('cancels a restore subprocess at its phase barrier and never starts session creation', async () => {
    const controller = new AbortController();
    const importing = Promise.withResolvers<void>();
    let quiesced = false;
    let ensured = false;
    const attaching = applySessionAttach(
      session,
      {},
      {
        ...noFs,
        signal: controller.signal,
        kiloClient: fakeKilo({
          ensureSession: async () => {
            ensured = true;
          },
        }),
        sessionExists: async () => false,
        restoreSession: async (_id, _directory, _file, options) => {
          expect(options?.signal).toBe(controller.signal);
          await runProcess(
            process.execPath,
            ['-e', 'process.stdout.write("importing"); setInterval(() => {}, 1000)'],
            {
              signal: options?.signal,
              onOutput: (_stream, output) => {
                if (output.includes('importing')) importing.resolve();
              },
            }
          );
          quiesced = true;
          return { ok: false, step: 'download', code: 404, error: 'not found' };
        },
      }
    );
    await importing.promise;
    controller.abort();
    expect(await attaching).toMatchObject({ ok: false });
    expect(quiesced).toBe(true);
    expect(ensured).toBe(false);
  });

  it('cancels clone before checkout, setup, or a bootstrap marker can run', async () => {
    const controller = new AbortController();
    const cloning = Promise.withResolvers<void>();
    const calls: string[] = [];
    let quiesced = false;
    const attaching = applySessionAttach(
      session,
      {
        git: { url: 'https://github.com/acme/demo.git' },
        branch: 'branch',
        setupCommands: ['setup'],
      },
      {
        kiloClient: fakeKilo(),
        signal: controller.signal,
        hasBootstrapMarker: async () => false,
        hasGit: async () => false,
        mkdir: async () => {},
        writeBootstrapMarker: async () => {
          calls.push('marker');
        },
        runSetup: async () => {
          calls.push('setup');
          return { exitCode: 0, stdout: '', stderr: '' };
        },
        runGit: async (args, _cwd, signal) => {
          calls.push(args[0] ?? '');
          expect(signal).toBe(controller.signal);
          const result = await runProcess(
            process.execPath,
            ['-e', 'process.stdout.write("cloning"); setInterval(() => {}, 1000)'],
            {
              signal,
              onOutput: (_stream, output) => {
                if (output.includes('cloning')) cloning.resolve();
              },
            }
          );
          quiesced = true;
          return result;
        },
      }
    );
    await cloning.promise;
    controller.abort();
    expect(await attaching).toMatchObject({ ok: false });
    expect(quiesced).toBe(true);
    expect(calls).toEqual(['clone']);
  });

  it('returns protocol_error for invalid payload', async () => {
    const result = await applySessionAttach(
      session,
      { git: { url: 1 } },
      { kiloClient: fakeKilo(), ...noFs }
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('protocol_error');
  });

  for (const key of CONTROL_RUNTIME_RESERVED_ENV_VARS) {
    it(`rejects ${key} before preparation, filesystem, or subprocess side effects`, async () => {
      const sideEffects: string[] = [];
      const sensitiveValue = 'must-not-appear-in-error';
      const result = await applySessionAttach(
        session,
        {
          env: { [key]: sensitiveValue },
          git: { url: 'https://github.com/acme/demo.git' },
          setupCommands: ['pnpm install'],
          preparation: { attemptId: 'att_1', triggerMessageId: 'msg_1' },
        },
        {
          kiloClient: fakeKilo(),
          hasBootstrapMarker: async () => {
            sideEffects.push('bootstrap');
            return false;
          },
          mkdir: async () => {
            sideEffects.push('mkdir');
          },
          runGit: async () => {
            sideEffects.push('git');
            return { stdout: '', stderr: '', exitCode: 0 };
          },
          runSetup: async () => {
            sideEffects.push('setup');
            return { stdout: '', stderr: '', exitCode: 0 };
          },
          emitPreparing: () => {
            sideEffects.push('preparing');
          },
        }
      );

      expect(result).toEqual({
        ok: false,
        error: {
          code: 'protocol_error',
          message: 'Reserved control runtime environment variable',
          retryable: false,
        },
      });
      expect(sideEffects).toEqual([]);
      expect(JSON.stringify(result)).not.toContain(sensitiveValue);
    });
  }
});
