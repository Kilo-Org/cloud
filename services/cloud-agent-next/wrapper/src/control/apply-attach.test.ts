import { describe, expect, it } from 'bun:test';
import { applySessionAttach } from './apply-attach';
import type { WrapperKiloClient } from '../kilo-api';
import type { PreparingEventDataV2 } from '../../../src/shared/protocol.js';

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

describe('applySessionAttach', () => {
  it('clones into the session directory without mutating process.env', async () => {
    const gitCalls: string[][] = [];
    const mkdirCalls: string[] = [];
    const envBefore = process.env.KILOCODE_TOKEN;
    const result = await applySessionAttach(
      session,
      {
        directory: '/workspace/a',
        branch: 'main',
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
    expect(gitCalls[1]).toEqual(['checkout', '-B', 'main']);
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
    expect(gitCalls).toEqual([]);
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
        kiloClient: fakeKilo({
          getSession: async () => {
            throw new Error('not found');
          },
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

  it('does not wait for a hanging kilo session probe', async () => {
    const result = await Promise.race([
      applySessionAttach(session, {}, { kiloClient: fakeKilo(), ...noFs }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('attach hung on getSession')), 50);
      }),
    ]);
    expect(result).toEqual({ ok: true, result: { attached: true } });
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
});
