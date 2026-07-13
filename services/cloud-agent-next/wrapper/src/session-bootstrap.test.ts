import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  materializePromptAttachments,
  prepareWrapperBootstrapWorkspace,
  RestoredWorkspaceReconciliationError,
  workspaceBootstrapErrorCode,
  type WrapperBootstrapDeps,
} from './session-bootstrap';
import type {
  WrapperPromptRequest,
  WrapperSessionReadyRequest,
} from '../../src/shared/wrapper-bootstrap';
import { buildCloudAgentRules } from '../../src/shared/cloud-agent-rules.js';
import { PNPM_STORE_DIR, PNPM_STORE_ENV_VAR } from '../../src/shared/runtime-environment.js';

function makeRequest(tmpDir: string, overrides: Partial<WrapperSessionReadyRequest> = {}) {
  const request: WrapperSessionReadyRequest = {
    agentSessionId: 'agent_12345678-1234-1234-1234-123456789abc',
    userId: 'user_test',
    sandboxId: 'usr-test',
    kiloSessionId: 'kilo_sess_1',
    workspace: {
      workspacePath: path.join(tmpDir, 'workspace'),
      sessionHome: path.join(tmpDir, 'home'),
      branchName: 'main',
      strictBranch: false,
      preferSnapshot: false,
    },
    repo: {
      kind: 'github',
      repo: 'acme/repo',
      token: 'gh-token',
      gitAuthor: { name: 'bot', email: 'bot@example.com' },
      refreshRemote: false,
    },
    materialized: {
      env: {
        HOME: path.join(tmpDir, 'home'),
        KILOCODE_TOKEN: 'kilo-capability',
        [PNPM_STORE_ENV_VAR]: PNPM_STORE_DIR,
      },
      setupCommands: ['pnpm install'],
      runtimeSkills: [{ name: 'test-skill', rawMarkdown: '# Test Skill' }],
    },
    session: {
      ingestUrl: 'wss://worker.example.com/sessions/user_test/agent/ingest',
      workerAuthToken: 'wrapper-dispatch-ticket',
      wrapperRunId: 'wr_test',
      wrapperGeneration: 1,
      wrapperConnectionId: 'conn_test',
    },
  };
  return { ...request, ...overrides };
}

function asFetch(
  fn: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>
): typeof fetch {
  return Object.assign(fn, { preconnect: fetch.preconnect });
}

async function createCompleteGitWorkspace(workspacePath: string): Promise<void> {
  const gitPath = path.join(workspacePath, '.git');
  await fsp.mkdir(gitPath, { recursive: true });
  await fsp.writeFile(path.join(gitPath, 'kilo-bootstrap-complete'), 'ready\n');
}

describe('prepareWrapperBootstrapWorkspace', () => {
  let tmpDir: string;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrapper-bootstrap-'));
    originalEnv = {
      HOME: process.env.HOME,
      KILOCODE_TOKEN: process.env.KILOCODE_TOKEN,
      GH_TOKEN: process.env.GH_TOKEN,
      [PNPM_STORE_ENV_VAR]: process.env[PNPM_STORE_ENV_VAR],
    };
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('prepares a cold workspace, restores Kilo, and runs setup commands', async () => {
    const request = makeRequest(tmpDir);
    const progress = mock(() => {});
    const gitCalls: string[][] = [];
    const setupCalls: string[][] = [];
    const restoreCalls: Array<{ kiloSessionId: string; workspacePath: string; filePath?: string }> =
      [];
    const deps: WrapperBootstrapDeps = {
      git: async args => {
        gitCalls.push(args);
        if (args[0] === 'clone') {
          await fsp.mkdir(path.join(request.workspace.workspacePath, '.git'), { recursive: true });
        }
        if (args[0] === 'rev-parse') {
          return { stdout: '', stderr: '', exitCode: 1 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      runProcess: async (command, args) => {
        setupCalls.push([command, ...args]);
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      restoreSession: async (kiloSessionId, workspacePath, filePath) => {
        restoreCalls.push({ kiloSessionId, workspacePath, filePath });
        return {
          ok: true,
          downloaded: false,
          imported: true,
          diffs: { applied: 0, skipped: 0, total: 0 },
        };
      },
    };

    const result = await prepareWrapperBootstrapWorkspace(request, progress, deps);

    expect(result.workspaceWasWarm).toBe(false);
    expect(progress).toHaveBeenLastCalledWith('kilo_server', 'Starting Kilo...');
    expect(gitCalls[0]).toEqual([
      'clone',
      '--progress',
      'https://x-access-token:gh-token@github.com/acme/repo.git',
      request.workspace.workspacePath,
    ]);
    expect(gitCalls.some(args => args.join(' ') === 'checkout --progress -b main')).toBe(true);
    expect(setupCalls).toEqual([['sh', '-lc', 'pnpm install']]);
    expect(restoreCalls[0]).toMatchObject({
      kiloSessionId: 'kilo_sess_1',
      workspacePath: request.workspace.workspacePath,
    });
    expect(restoreCalls[0].filePath).toContain('/tmp/kilo-empty-session-kilo_sess_1.json');
    expect(
      fs.existsSync(
        path.join(request.workspace.sessionHome, '.kilocode/skills/test-skill/SKILL.md')
      )
    ).toBe(true);
    expect(
      await fsp.readFile(
        path.join(request.workspace.sessionHome, '.kilocode/rules/cloud-agent.md'),
        'utf8'
      )
    ).toBe(buildCloudAgentRules(request.agentSessionId));
    expect(
      fs.existsSync(path.join(request.workspace.workspacePath, '.git', 'kilo-bootstrap-complete'))
    ).toBe(true);
    const authFile = await fsp.readFile(
      path.join(request.workspace.sessionHome, '.local/share/kilo/auth.json'),
      'utf8'
    );
    expect(JSON.parse(authFile)).toEqual({ kilo: { type: 'api', key: 'kilo-capability' } });
    expect(authFile).not.toContain('wrapper-dispatch-ticket');
  });

  it('uses activity watchdogs and reports sanitized progress for long git operations', async () => {
    const request = makeRequest(tmpDir);
    request.materialized.setupCommands = [];
    const gitCalls: Array<{
      args: string[];
      opts: Parameters<NonNullable<WrapperBootstrapDeps['git']>>[1];
    }> = [];
    const progress = mock(() => {});

    await prepareWrapperBootstrapWorkspace(request, progress, {
      git: async (args, opts) => {
        gitCalls.push({ args, opts });
        if (args[0] === 'clone') {
          await fsp.mkdir(path.join(request.workspace.workspacePath, '.git'), { recursive: true });
          opts?.onOutput?.(
            'stderr',
            'remote: https://x-access-token:gh-token@github.com/acme/repo.git Receiving objects: 42% (42/100)\n'
          );
        }
        if (args[0] === 'rev-parse') {
          return { stdout: '', stderr: '', exitCode: 1 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      restoreSession: async () => ({
        ok: true,
        downloaded: false,
        imported: true,
        diffs: { applied: 0, skipped: 0, total: 0 },
      }),
    });

    const cloneCall = gitCalls.find(call => call.args[0] === 'clone');
    expect(cloneCall?.args).toContain('--progress');
    expect(cloneCall?.opts?.inactivityTimeoutMs).toBe(120_000);
    expect(cloneCall?.opts?.hardTimeoutMs).toBe(300_000);
    expect(gitCalls.some(call => call.args.join(' ') === 'fetch --progress origin')).toBe(true);
    expect(gitCalls.some(call => call.args.join(' ') === 'checkout --progress -b main')).toBe(true);
    expect(progress).toHaveBeenCalledWith(
      'cloning',
      'Cloning repository... Receiving objects: 42%'
    );
    expect(progress.mock.calls.flat().join(' ')).not.toContain('gh-token');
  });

  it('fails and cleans up when a repository fetch reaches its hard limit', async () => {
    const request = makeRequest(tmpDir);
    request.materialized.setupCommands = [];

    let caughtError: unknown;
    try {
      await prepareWrapperBootstrapWorkspace(request, undefined, {
        git: async args => {
          if (args[0] === 'clone') {
            await fsp.mkdir(path.join(request.workspace.workspacePath, '.git'), {
              recursive: true,
            });
          }
          if (args[0] === 'fetch') {
            return {
              stdout: '',
              stderr: 'exec hard timeout reached',
              exitCode: 124,
              terminationReason: 'hard_timeout',
            };
          }
          if (args[0] === 'rev-parse') {
            return { stdout: '', stderr: '', exitCode: 1 };
          }
          return { stdout: '', stderr: '', exitCode: 0 };
        },
        restoreSession: async () => {
          throw new Error('restore should not run after fetch timeout');
        },
      });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toMatchObject({
      code: 'WORKSPACE_SETUP_FAILED',
      subtype: 'git_checkout_timeout',
      retryable: true,
      message: 'Repository checkout timed out',
      detail: 'termination hard_timeout',
    });
    expect(JSON.stringify(caughtError)).not.toContain('exec hard timeout reached');
    expect(fs.existsSync(request.workspace.workspacePath)).toBe(false);
    expect(fs.existsSync(request.workspace.sessionHome)).toBe(false);
  });

  it('aborts active work and cleans up when the shared workspace deadline expires', async () => {
    const request = makeRequest(tmpDir);
    request.materialized.setupCommands = [];
    let commandSignal: AbortSignal | undefined;
    let caughtError: unknown;

    try {
      await prepareWrapperBootstrapWorkspace(request, undefined, {
        workspacePreparationTimeoutMs: 20,
        git: async (args, opts) => {
          if (args[0] !== 'clone') {
            return { stdout: '', stderr: '', exitCode: 0 };
          }

          await fsp.mkdir(path.join(request.workspace.workspacePath, '.git'), { recursive: true });
          commandSignal = opts?.signal;
          if (!commandSignal) {
            return { stdout: '', stderr: 'missing workspace signal', exitCode: 1 };
          }
          if (!commandSignal.aborted) {
            await new Promise<void>(resolve =>
              commandSignal?.addEventListener('abort', () => resolve(), { once: true })
            );
          }
          return {
            stdout: '',
            stderr: 'exec aborted',
            exitCode: 124,
            terminationReason: 'abort',
          };
        },
      });
    } catch (error) {
      caughtError = error;
    }

    expect(commandSignal?.aborted).toBe(true);
    expect(caughtError).toMatchObject({
      code: 'WORKSPACE_SETUP_FAILED',
      subtype: 'workspace_setup_unknown',
      retryable: true,
      message: expect.stringContaining('Workspace preparation timed out'),
    });
    expect(fs.existsSync(request.workspace.workspacePath)).toBe(false);
    expect(fs.existsSync(request.workspace.sessionHome)).toBe(false);
  });

  it('aborts active work and cleans up when the wrapper shuts down', async () => {
    const request = makeRequest(tmpDir);
    request.materialized.setupCommands = [];
    const shutdownController = new AbortController();
    let commandSignal: AbortSignal | undefined;
    let notifyCloneStarted: (() => void) | undefined;
    const cloneStarted = new Promise<void>(resolve => {
      notifyCloneStarted = resolve;
    });

    const bootstrap = prepareWrapperBootstrapWorkspace(
      request,
      undefined,
      {
        workspacePreparationTimeoutMs: 100,
        git: async (args, opts) => {
          if (args[0] !== 'clone') {
            return { stdout: '', stderr: '', exitCode: 0 };
          }

          await fsp.mkdir(path.join(request.workspace.workspacePath, '.git'), { recursive: true });
          commandSignal = opts?.signal;
          notifyCloneStarted?.();
          if (!commandSignal) {
            return { stdout: '', stderr: 'missing workspace signal', exitCode: 1 };
          }
          if (!commandSignal.aborted) {
            await new Promise<void>(resolve =>
              commandSignal?.addEventListener('abort', () => resolve(), { once: true })
            );
          }
          await Bun.sleep(120);
          return {
            stdout: '',
            stderr: 'exec aborted',
            exitCode: 124,
            terminationReason: 'abort',
          };
        },
      },
      shutdownController.signal
    );

    await cloneStarted;
    shutdownController.abort();

    let caughtError: unknown;
    try {
      await bootstrap;
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toMatchObject({
      code: 'WORKSPACE_SETUP_FAILED',
      subtype: 'workspace_setup_unknown',
      retryable: true,
      message: 'Repository clone failed',
    });
    expect(commandSignal?.aborted).toBe(true);
    expect(fs.existsSync(request.workspace.workspacePath)).toBe(false);
    expect(fs.existsSync(request.workspace.sessionHome)).toBe(false);
  });

  it('uses a lenient inactivity watchdog and generic progress for setup commands', async () => {
    const request = makeRequest(tmpDir);
    const progress = mock(() => {});
    let setupOptions: Parameters<NonNullable<WrapperBootstrapDeps['runProcess']>>[2];
    let markerExistedDuringSetup = true;

    await prepareWrapperBootstrapWorkspace(request, progress, {
      git: async (args, opts) => {
        if (args[0] === 'clone') {
          await fsp.mkdir(path.join(request.workspace.workspacePath, '.git'), { recursive: true });
        }
        if (args[0] === 'rev-parse') {
          return { stdout: '', stderr: '', exitCode: 1 };
        }
        opts?.onOutput?.('stderr', 'Updating files: 100% (1/1)\n');
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      runProcess: async (_command, _args, opts) => {
        setupOptions = opts;
        markerExistedDuringSetup = fs.existsSync(
          path.join(request.workspace.workspacePath, '.git', 'kilo-bootstrap-complete')
        );
        opts?.onOutput?.('stdout', 'secret setup output');
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      restoreSession: async () => ({
        ok: true,
        downloaded: false,
        imported: true,
        diffs: { applied: 0, skipped: 0, total: 0 },
      }),
    });

    expect(setupOptions?.inactivityTimeoutMs).toBe(240_000);
    expect(setupOptions?.hardTimeoutMs).toBe(300_000);
    expect(markerExistedDuringSetup).toBe(false);
    expect(
      fs.existsSync(path.join(request.workspace.workspacePath, '.git', 'kilo-bootstrap-complete'))
    ).toBe(true);
    expect(progress).toHaveBeenCalledWith(
      'setup_commands',
      'Setup command 1 of 1 is still running...'
    );
    expect(progress.mock.calls.flat().join(' ')).not.toContain('secret setup output');
  });

  it('fetches and checks out strict GitHub pull refs directly', async () => {
    const request = makeRequest(tmpDir);
    request.workspace.branchName = 'refs/pull/123/head';
    request.workspace.strictBranch = true;
    request.materialized.setupCommands = [];
    const gitCalls: string[][] = [];
    const deps: WrapperBootstrapDeps = {
      git: async args => {
        gitCalls.push(args);
        if (args[0] === 'clone') {
          await fsp.mkdir(path.join(request.workspace.workspacePath, '.git'), { recursive: true });
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      restoreSession: async () => ({
        ok: true,
        downloaded: false,
        imported: true,
        diffs: { applied: 0, skipped: 0, total: 0 },
      }),
    };

    await prepareWrapperBootstrapWorkspace(request, undefined, deps);

    expect(gitCalls).toContainEqual(['fetch', '--progress', 'origin', 'refs/pull/123/head']);
    expect(gitCalls).toContainEqual([
      'checkout',
      '--progress',
      '-B',
      'refs/pull/123/head',
      'FETCH_HEAD',
    ]);
    expect(gitCalls.some(args => args[0] === 'rev-parse')).toBe(false);
  });

  it('fetches and checks out strict GitLab merge-request refs directly', async () => {
    const request = makeRequest(tmpDir);
    request.workspace.branchName = 'refs/merge-requests/99/head';
    request.workspace.strictBranch = true;
    request.materialized.setupCommands = [];
    const gitCalls: string[][] = [];
    const deps: WrapperBootstrapDeps = {
      git: async args => {
        gitCalls.push(args);
        if (args[0] === 'clone') {
          await fsp.mkdir(path.join(request.workspace.workspacePath, '.git'), { recursive: true });
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      restoreSession: async () => ({
        ok: true,
        downloaded: false,
        imported: true,
        diffs: { applied: 0, skipped: 0, total: 0 },
      }),
    };

    await prepareWrapperBootstrapWorkspace(request, undefined, deps);

    expect(gitCalls).toContainEqual([
      'fetch',
      '--progress',
      'origin',
      'refs/merge-requests/99/head',
    ]);
    expect(gitCalls).toContainEqual([
      'checkout',
      '--progress',
      '-B',
      'refs/merge-requests/99/head',
      'FETCH_HEAD',
    ]);
    expect(gitCalls.some(args => args[0] === 'rev-parse')).toBe(false);
  });

  it('keeps cold snapshot resumes alive when a setup command fails', async () => {
    const request = makeRequest(tmpDir);
    request.workspace.preferSnapshot = true;
    const deps: WrapperBootstrapDeps = {
      git: async args => {
        if (args[0] === 'clone') {
          await fsp.mkdir(path.join(request.workspace.workspacePath, '.git'), { recursive: true });
        }
        if (args[0] === 'rev-parse') {
          return { stdout: '', stderr: '', exitCode: 1 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      runProcess: async () => ({ stdout: '', stderr: 'transient install failure', exitCode: 1 }),
      restoreSession: async () => ({
        ok: true,
        downloaded: true,
        imported: true,
        diffs: { applied: 0, skipped: 0, total: 0 },
      }),
    };

    const result = await prepareWrapperBootstrapWorkspace(request, undefined, deps);

    expect(result).toEqual({
      workspaceWasWarm: false,
    });
  });

  it.each([
    {
      name: 'clone timeout',
      stage: 'clone',
      result: { stdout: '', stderr: '', exitCode: 124, terminationReason: 'timeout' as const },
      subtype: 'git_clone_timeout',
    },
    {
      name: 'clone authentication failure',
      stage: 'clone',
      result: {
        stdout: '',
        stderr: 'fatal: Authentication failed for credentialed repository',
        exitCode: 128,
      },
      subtype: 'git_authentication_failed',
    },
    {
      name: 'clone network failure',
      stage: 'clone',
      result: { stdout: '', stderr: 'fatal: the remote end hung up unexpectedly', exitCode: 128 },
      subtype: 'git_network_failed',
    },
    {
      name: 'clone corrupt pack',
      stage: 'clone',
      result: { stdout: '', stderr: 'fatal: pack has bad object at offset', exitCode: 128 },
      subtype: 'git_pack_corrupt',
    },
    {
      name: 'clone storage exhaustion',
      stage: 'clone',
      result: { stdout: '', stderr: 'fatal: No space left on device', exitCode: 128 },
      subtype: 'sandbox_storage_full',
    },
    {
      name: 'checkout timeout',
      stage: 'checkout',
      result: { stdout: '', stderr: '', exitCode: 124, terminationReason: 'timeout' as const },
      subtype: 'git_checkout_timeout',
    },
    {
      name: 'checkout conflict',
      stage: 'checkout',
      result: {
        stdout: '',
        stderr: 'untracked working tree files would be overwritten by checkout',
        exitCode: 1,
      },
      subtype: 'git_checkout_conflict',
    },
  ])('classifies $name without exposing credentials', async ({ stage, result, subtype }) => {
    const request = makeRequest(tmpDir);
    request.materialized.setupCommands = [];
    const deps: WrapperBootstrapDeps = {
      git: async args => {
        if (args[0] === 'clone') {
          if (stage === 'clone') return result;
          await fsp.mkdir(path.join(request.workspace.workspacePath, '.git'), { recursive: true });
        }
        if (args[0] === 'rev-parse') return { stdout: 'main', stderr: '', exitCode: 0 };
        if (args[0] === 'checkout' && stage === 'checkout') return result;
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      restoreSession: async () => ({
        ok: true,
        downloaded: false,
        imported: true,
        diffs: { applied: 0, skipped: 0, total: 0 },
      }),
    };

    expect(prepareWrapperBootstrapWorkspace(request, undefined, deps)).rejects.toMatchObject({
      code: 'WORKSPACE_SETUP_FAILED',
      subtype,
      retryable: true,
    });
  });

  it('keeps strict-branch fetch timeouts retryable', async () => {
    const request = makeRequest(tmpDir);
    request.workspace.strictBranch = true;
    request.materialized.setupCommands = [];

    expect(
      prepareWrapperBootstrapWorkspace(request, undefined, {
        git: async args => {
          if (args[0] === 'clone') {
            await fsp.mkdir(path.join(request.workspace.workspacePath, '.git'), {
              recursive: true,
            });
            return { stdout: '', stderr: '', exitCode: 0 };
          }
          if (args[0] === 'fetch') {
            return {
              stdout: '',
              stderr: '',
              exitCode: 124,
              terminationReason: 'timeout',
            };
          }
          return { stdout: '', stderr: '', exitCode: 0 };
        },
        restoreSession: async () => ({
          ok: true,
          downloaded: false,
          imported: true,
          diffs: { applied: 0, skipped: 0, total: 0 },
        }),
      })
    ).rejects.toMatchObject({
      subtype: 'git_checkout_timeout',
      retryable: true,
    });
  });

  it('keeps strict-branch reference probe timeouts retryable', async () => {
    const request = makeRequest(tmpDir);
    request.workspace.strictBranch = true;
    request.materialized.setupCommands = [];

    expect(
      prepareWrapperBootstrapWorkspace(request, undefined, {
        git: async args => {
          if (args[0] === 'clone') {
            await fsp.mkdir(path.join(request.workspace.workspacePath, '.git'), {
              recursive: true,
            });
          }
          if (args[0] === 'rev-parse') {
            return {
              stdout: '',
              stderr: '',
              exitCode: 124,
              terminationReason: 'timeout',
            };
          }
          return { stdout: '', stderr: '', exitCode: 0 };
        },
        restoreSession: async () => ({
          ok: true,
          downloaded: false,
          imported: true,
          diffs: { applied: 0, skipped: 0, total: 0 },
        }),
      })
    ).rejects.toMatchObject({
      subtype: 'git_checkout_timeout',
      retryable: true,
    });
  });

  it('classifies strict missing branches', async () => {
    const request = makeRequest(tmpDir);
    request.workspace.strictBranch = true;
    request.materialized.setupCommands = [];
    expect(
      prepareWrapperBootstrapWorkspace(request, undefined, {
        git: async args => {
          if (args[0] === 'clone') {
            await fsp.mkdir(path.join(request.workspace.workspacePath, '.git'), {
              recursive: true,
            });
          }
          return { stdout: '', stderr: '', exitCode: args[0] === 'rev-parse' ? 1 : 0 };
        },
        restoreSession: async () => ({
          ok: true,
          downloaded: false,
          imported: true,
          diffs: { applied: 0, skipped: 0, total: 0 },
        }),
      })
    ).rejects.toMatchObject({
      subtype: 'git_branch_missing',
      retryable: false,
    });
  });

  it('still fails fresh cold bootstraps without exposing setup command or output', async () => {
    const request = makeRequest(tmpDir);
    request.materialized.setupCommands = ['private-tool --token argv-secret'];
    const deps: WrapperBootstrapDeps = {
      git: async args => {
        if (args[0] === 'clone') {
          await fsp.mkdir(path.join(request.workspace.workspacePath, '.git'), { recursive: true });
        }
        if (args[0] === 'rev-parse') {
          return { stdout: '', stderr: '', exitCode: 1 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      runProcess: async () => ({
        stdout: 'private-file-content',
        stderr: [
          'bare-unlabeled-token',
          'https://user:url-secret@example.com/repo.git',
          'Authorization: Bearer bearer-secret',
          'Cookie: session=cookie-secret',
          'SECRET_VALUE=env-secret',
        ].join('\n'),
        exitCode: 1,
        elapsedMs: 17,
        stderrTruncated: true,
      }),
      restoreSession: async () => ({
        ok: true,
        downloaded: false,
        imported: true,
        diffs: { applied: 0, skipped: 0, total: 0 },
      }),
    };

    let setupError: unknown;
    try {
      await prepareWrapperBootstrapWorkspace(request, undefined, deps);
    } catch (error) {
      setupError = error;
    }

    if (!(setupError instanceof Error)) {
      throw new Error('Expected setup command failure');
    }

    expect(setupError).toMatchObject({
      code: 'WORKSPACE_SETUP_FAILED',
      subtype: 'setup_command_failed',
      retryable: true,
    });
    expect(setupError.message).toBe('Setup command 1 failed');
    expect(setupError).toMatchObject({
      detail: 'termination nonzero exit, exit code 1, output truncated',
    });
    const projectedError = JSON.stringify(setupError);
    for (const sensitiveValue of [
      'private-tool',
      'argv-secret',
      'private-file-content',
      'bare-unlabeled-token',
      'url-secret',
      'bearer-secret',
      'cookie-secret',
      'env-secret',
    ]) {
      expect(projectedError).not.toContain(sensitiveValue);
    }
  });

  it('classifies setup command timeouts with a safe command index', async () => {
    const request = makeRequest(tmpDir);
    expect(
      prepareWrapperBootstrapWorkspace(request, undefined, {
        git: async args => {
          if (args[0] === 'clone') {
            await fsp.mkdir(path.join(request.workspace.workspacePath, '.git'), {
              recursive: true,
            });
          }
          if (args[0] === 'rev-parse') return { stdout: '', stderr: '', exitCode: 1 };
          return { stdout: '', stderr: '', exitCode: 0 };
        },
        runProcess: async () => ({
          stdout: '',
          stderr: 'Authorization: Bearer setup-secret',
          exitCode: 124,
          terminationReason: 'timeout',
          elapsedMs: 300_000,
        }),
        restoreSession: async () => ({
          ok: true,
          downloaded: false,
          imported: true,
          diffs: { applied: 0, skipped: 0, total: 0 },
        }),
      })
    ).rejects.toMatchObject({
      subtype: 'setup_command_timeout',
      message: expect.not.stringContaining('setup-secret'),
      detail: expect.not.stringContaining('setup-secret'),
    });
  });

  it('uses an unknown workspace subtype for untyped failures', async () => {
    const request = makeRequest(tmpDir);
    expect(
      prepareWrapperBootstrapWorkspace(request, undefined, {
        git: async () => {
          throw new Error('unexpected internal failure');
        },
      })
    ).rejects.toMatchObject({
      code: 'WORKSPACE_SETUP_FAILED',
      subtype: 'workspace_setup_unknown',
    });
  });

  it('reclones legacy markerless workspaces instead of trusting auth.json', async () => {
    const request = makeRequest(tmpDir);
    request.workspace.preferSnapshot = true;
    // The legacy flow wrote auth.json before restore and setup commands ran,
    // so its presence does not prove bootstrap completed.
    await fsp.mkdir(path.join(request.workspace.workspacePath, '.git'), { recursive: true });
    const authPath = path.join(request.workspace.sessionHome, '.local/share/kilo/auth.json');
    await fsp.mkdir(path.dirname(authPath), { recursive: true });
    await fsp.writeFile(authPath, '{}');
    const gitCalls: string[][] = [];

    const result = await prepareWrapperBootstrapWorkspace(request, undefined, {
      git: async args => {
        gitCalls.push(args);
        if (args[0] === 'clone') {
          await fsp.mkdir(path.join(request.workspace.workspacePath, '.git'), { recursive: true });
        }
        if (args[0] === 'rev-parse') {
          return { stdout: '', stderr: '', exitCode: 1 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      runProcess: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      restoreSession: async () => ({
        ok: true,
        downloaded: false,
        imported: true,
        diffs: { applied: 0, skipped: 0, total: 0 },
      }),
    });

    expect(result.workspaceWasWarm).toBe(false);
    expect(gitCalls.some(args => args[0] === 'clone')).toBe(true);
    expect(
      fs.existsSync(path.join(request.workspace.workspacePath, '.git', 'kilo-bootstrap-complete'))
    ).toBe(true);
  });

  it('reclones unfinished workspaces that have no bootstrap marker', async () => {
    const request = makeRequest(tmpDir);
    await fsp.mkdir(path.join(request.workspace.workspacePath, '.git'), { recursive: true });
    await fsp.writeFile(path.join(request.workspace.workspacePath, 'partial-clone.txt'), 'stale');
    const authPath = path.join(request.workspace.sessionHome, '.local/share/kilo/auth.json');
    await fsp.mkdir(path.dirname(authPath), { recursive: true });
    await fsp.writeFile(authPath, '{}');

    const gitCalls: string[][] = [];
    const setupCalls: string[][] = [];
    const restoreCalls: Array<{ kiloSessionId: string; workspacePath: string; filePath?: string }> =
      [];
    const deps: WrapperBootstrapDeps = {
      git: async args => {
        gitCalls.push(args);
        if (args[0] === 'clone') {
          await fsp.mkdir(path.join(request.workspace.workspacePath, '.git'), { recursive: true });
        }
        if (args[0] === 'rev-parse') {
          return { stdout: '', stderr: '', exitCode: 1 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      runProcess: async (command, args) => {
        setupCalls.push([command, ...args]);
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      restoreSession: async (kiloSessionId, workspacePath, filePath) => {
        restoreCalls.push({ kiloSessionId, workspacePath, filePath });
        return {
          ok: true,
          downloaded: false,
          imported: true,
          diffs: { applied: 0, skipped: 0, total: 0 },
        };
      },
    };

    const result = await prepareWrapperBootstrapWorkspace(request, undefined, deps);

    expect(result.workspaceWasWarm).toBe(false);
    expect(gitCalls.some(args => args[0] === 'clone')).toBe(true);
    expect(gitCalls.some(args => args.join(' ') === 'rev-parse --is-inside-work-tree')).toBe(false);
    expect(gitCalls.some(args => args.join(' ') === 'checkout --progress -b main')).toBe(true);
    expect(fs.existsSync(path.join(request.workspace.workspacePath, 'partial-clone.txt'))).toBe(
      false
    );
    expect(restoreCalls[0]).toMatchObject({
      kiloSessionId: 'kilo_sess_1',
      workspacePath: request.workspace.workspacePath,
    });
    expect(restoreCalls[0].filePath).toContain('/tmp/kilo-empty-session-kilo_sess_1.json');
    expect(setupCalls).toEqual([['sh', '-lc', 'pnpm install']]);
  });

  it('leaves a cold Bitbucket review origin credential-free before restoring Kilo', async () => {
    const request = makeRequest(tmpDir, {
      repo: {
        kind: 'git',
        url: 'https://bitbucket.org/acme/repo.git',
        token: 'managed-token',
        platform: 'bitbucket',
        refreshRemote: true,
      },
      materialized: {
        env: {
          HOME: path.join(tmpDir, 'home'),
          KILOCODE_TOKEN: 'kilo-token',
          KILO_PLATFORM: 'code-review',
        },
      },
    });
    const events: string[] = [];
    const gitCalls: string[][] = [];

    await prepareWrapperBootstrapWorkspace(request, undefined, {
      git: async args => {
        gitCalls.push(args);
        events.push(`git:${args.join(' ')}`);
        if (args[0] === 'clone') {
          await fsp.mkdir(path.join(request.workspace.workspacePath, '.git'), { recursive: true });
        }
        if (args[0] === 'rev-parse' && args[1] === '--verify') {
          return { stdout: '', stderr: '', exitCode: 1 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      restoreSession: async () => {
        events.push('restore');
        return {
          ok: true,
          downloaded: false,
          imported: true,
          diffs: { applied: 0, skipped: 0, total: 0 },
        };
      },
    });

    expect(gitCalls[0]).toContain('https://x-token-auth:managed-token@bitbucket.org/acme/repo.git');
    const sanitizedRemote = 'git:remote set-url origin https://bitbucket.org/acme/repo.git';
    expect(events).toContain(sanitizedRemote);
    expect(events.indexOf(sanitizedRemote)).toBeLessThan(events.indexOf('restore'));
    expect(sanitizedRemote).not.toContain('managed-token');
  });

  it('uses the warm path by refreshing the git remote without rerunning setup', async () => {
    const request = makeRequest(tmpDir, {
      workspace: {
        workspacePath: path.join(tmpDir, 'workspace'),
        sessionHome: path.join(tmpDir, 'home'),
        branchName: 'main',
        preferSnapshot: true,
      },
      repo: {
        kind: 'git',
        url: 'https://gitlab.com/acme/repo.git',
        token: 'gitlab-token',
        platform: 'gitlab',
        refreshRemote: true,
      },
    });
    await createCompleteGitWorkspace(request.workspace.workspacePath);
    const rulesPath = path.join(request.workspace.sessionHome, '.kilocode/rules/cloud-agent.md');
    await fsp.mkdir(path.dirname(rulesPath), { recursive: true });
    await fsp.writeFile(rulesPath, 'stale rules');

    const gitCalls: string[][] = [];
    const deps: WrapperBootstrapDeps = {
      git: async args => {
        gitCalls.push(args);
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      runProcess: async () => {
        throw new Error('setup commands should not run on warm path');
      },
      restoreSession: async () => {
        throw new Error('session restore should not run on warm path');
      },
    };

    const progress = mock(() => {});
    const result = await prepareWrapperBootstrapWorkspace(request, progress, deps);

    expect(result.workspaceWasWarm).toBe(true);
    expect(progress).toHaveBeenCalledWith('kilo_server', 'Starting Kilo...');
    expect(gitCalls).toEqual([
      ['remote', 'set-url', 'origin', 'https://oauth2:gitlab-token@gitlab.com/acme/repo.git'],
    ]);
    expect(await fsp.readFile(rulesPath, 'utf8')).toBe(
      buildCloudAgentRules(request.agentSessionId)
    );
  });

  it('refreshes a warm Bitbucket remote with x-token-auth', async () => {
    const request = makeRequest(tmpDir, {
      workspace: {
        workspacePath: path.join(tmpDir, 'workspace'),
        sessionHome: path.join(tmpDir, 'home'),
        branchName: 'main',
        preferSnapshot: true,
      },
      repo: {
        kind: 'git',
        url: 'https://bitbucket.org/acme/repo.git',
        token: 'bitbucket-token',
        platform: 'bitbucket',
        refreshRemote: true,
      },
    });
    await createCompleteGitWorkspace(request.workspace.workspacePath);
    const gitCalls: string[][] = [];

    await prepareWrapperBootstrapWorkspace(request, undefined, {
      git: async args => {
        gitCalls.push(args);
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });

    expect(gitCalls).toEqual([
      [
        'remote',
        'set-url',
        'origin',
        'https://x-token-auth:bitbucket-token@bitbucket.org/acme/repo.git',
      ],
    ]);
  });

  it('leaves a warm Bitbucket review origin credential-free before Kilo starts', async () => {
    const request = makeRequest(tmpDir, {
      workspace: {
        workspacePath: path.join(tmpDir, 'workspace'),
        sessionHome: path.join(tmpDir, 'home'),
        branchName: 'main',
        preferSnapshot: true,
      },
      repo: {
        kind: 'git',
        url: 'https://bitbucket.org/acme/repo.git',
        token: 'bitbucket-token',
        platform: 'bitbucket',
        refreshRemote: true,
      },
      materialized: {
        env: { KILO_PLATFORM: 'code-review', KILOCODE_TOKEN: 'kilo-capability' },
      },
    });
    await createCompleteGitWorkspace(request.workspace.workspacePath);
    const authPath = path.join(request.workspace.sessionHome, '.local/share/kilo/auth.json');
    await fsp.mkdir(path.dirname(authPath), { recursive: true });
    await fsp.writeFile(
      authPath,
      JSON.stringify({ kilo: { type: 'api', key: 'stale-capability' } })
    );
    const gitCalls: string[][] = [];

    await prepareWrapperBootstrapWorkspace(request, undefined, {
      git: async args => {
        gitCalls.push(args);
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });

    expect(gitCalls).toEqual([
      ['remote', 'set-url', 'origin', 'https://bitbucket.org/acme/repo.git'],
    ]);
    expect(gitCalls.at(-1)?.join(' ')).not.toContain('bitbucket-token');
    expect(JSON.parse(await fsp.readFile(authPath, 'utf8'))).toEqual({
      kilo: { type: 'api', key: 'kilo-capability' },
    });
  });

  it('refreshes a warm GitHub remote, author, and selected CLI credential', async () => {
    const request = makeRequest(tmpDir, {
      workspace: {
        workspacePath: path.join(tmpDir, 'workspace'),
        sessionHome: path.join(tmpDir, 'home'),
        branchName: 'session/test',
        preferSnapshot: true,
      },
      repo: {
        kind: 'github',
        repo: 'acme/repo',
        token: 'user-token',
        gitAuthor: { name: 'octocat', email: '1+octocat@users.noreply.github.com' },
        refreshRemote: true,
      },
      materialized: {
        env: { GH_TOKEN: 'user-token', KILOCODE_TOKEN: 'kilo-capability' },
      },
    });
    await createCompleteGitWorkspace(request.workspace.workspacePath);
    const gitCalls: string[][] = [];

    await prepareWrapperBootstrapWorkspace(request, undefined, {
      git: async args => {
        gitCalls.push(args);
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });

    expect(process.env.GH_TOKEN).toBe('user-token');
    expect(gitCalls).toEqual([
      ['remote', 'set-url', 'origin', 'https://x-access-token:user-token@github.com/acme/repo.git'],
      ['config', 'user.name', 'octocat'],
      ['config', 'user.email', '1+octocat@users.noreply.github.com'],
    ]);
  });

  it('reconciles a same-commit restored workspace before running every setup command', async () => {
    const request = makeRequest(tmpDir);
    request.workspace.branchName = 'session/new';
    request.workspace.upstreamBranch = 'feature/source';
    request.workspace.restoredFromBackup = true;
    request.materialized.setupCommands = ['prepare one', 'prepare two'];
    await createCompleteGitWorkspace(request.workspace.workspacePath);
    const events: string[] = [];

    await prepareWrapperBootstrapWorkspace(request, undefined, {
      git: async args => {
        events.push(`git:${args.join(' ')}`);
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      runProcess: async (command, args) => {
        events.push(`process:${command} ${args.join(' ')}`);
        expect(process.env.HOME).toBe(request.workspace.sessionHome);
        expect(process.env.KILOCODE_TOKEN).toBe('kilo-capability');
        expect(process.env[PNPM_STORE_ENV_VAR]).toBe(PNPM_STORE_DIR);
        expect(
          fs.existsSync(path.join(request.workspace.sessionHome, '.local/share/kilo/auth.json'))
        ).toBe(true);
        expect(
          fs.existsSync(path.join(request.workspace.sessionHome, '.kilocode/rules/cloud-agent.md'))
        ).toBe(true);
        expect(
          fs.existsSync(
            path.join(request.workspace.sessionHome, '.kilocode/skills/test-skill/SKILL.md')
          )
        ).toBe(true);
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      restoreSession: async () => ({
        ok: true,
        downloaded: false,
        imported: true,
        diffs: { applied: 0, skipped: 0, total: 0 },
      }),
    });

    expect(events).toContain(
      'git:remote set-url origin https://x-access-token:gh-token@github.com/acme/repo.git'
    );
    const fetchIndex = events.indexOf('git:fetch origin feature/source');
    const checkoutIndex = events.indexOf('git:checkout -B session/new FETCH_HEAD');
    const firstSetupIndex = events.indexOf('process:sh -lc prepare one');
    expect(fetchIndex).toBeGreaterThan(-1);
    expect(checkoutIndex).toBeGreaterThan(fetchIndex);
    expect(firstSetupIndex).toBeGreaterThan(checkoutIndex);
    expect(events.filter(event => event.startsWith('process:'))).toEqual([
      'process:sh -lc prepare one',
      'process:sh -lc prepare two',
    ]);
  });

  it('keeps restored workspace setup failures as ordinary setup failures', async () => {
    const request = makeRequest(tmpDir);
    request.workspace.restoredFromBackup = true;
    await fsp.mkdir(path.join(request.workspace.workspacePath, '.git'), { recursive: true });

    let setupError: unknown;
    try {
      await prepareWrapperBootstrapWorkspace(request, undefined, {
        git: async args => {
          if (args.join(' ') === 'ls-remote --symref origin HEAD') {
            return { stdout: 'ref: refs/heads/main\tHEAD\n', stderr: '', exitCode: 0 };
          }
          return { stdout: '', stderr: '', exitCode: 0 };
        },
        runProcess: async () => ({ stdout: '', stderr: 'install failed', exitCode: 17 }),
        restoreSession: async () => ({
          ok: true,
          downloaded: false,
          imported: true,
          diffs: { applied: 0, skipped: 0, total: 0 },
        }),
      });
    } catch (error) {
      setupError = error;
    }

    expect(setupError).toBeInstanceOf(Error);
    expect(setupError).not.toBeInstanceOf(RestoredWorkspaceReconciliationError);
    expect(workspaceBootstrapErrorCode(setupError)).toBe('WORKSPACE_SETUP_FAILED');
    expect((setupError as Error).message).toContain('Setup command 1 failed');
  });

  it('classifies restored workspace reconciliation failures before setup', async () => {
    const request = makeRequest(tmpDir);
    request.workspace.restoredFromBackup = true;
    await createCompleteGitWorkspace(request.workspace.workspacePath);
    let setupRan = false;

    let reconciliationError: unknown;
    try {
      await prepareWrapperBootstrapWorkspace(request, undefined, {
        git: async args => {
          if (args.join(' ') === 'ls-remote --symref origin HEAD') {
            return { stdout: 'ref: refs/heads/main\tHEAD\n', stderr: '', exitCode: 0 };
          }
          if (args.join(' ') === 'fetch origin main') {
            return { stdout: '', stderr: 'remote unavailable', exitCode: 1 };
          }
          return { stdout: '', stderr: '', exitCode: 0 };
        },
        runProcess: async () => {
          setupRan = true;
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      });
    } catch (error) {
      reconciliationError = error;
    }

    expect(reconciliationError).toBeInstanceOf(RestoredWorkspaceReconciliationError);
    expect(workspaceBootstrapErrorCode(reconciliationError)).toBe(
      'WORKSPACE_RECONCILIATION_FAILED'
    );
    expect((reconciliationError as Error).message).toBe(
      'Failed to fetch authoritative remote state'
    );
    expect(setupRan).toBe(false);
    expect(fs.existsSync(request.workspace.workspacePath)).toBe(false);
    expect(fs.existsSync(request.workspace.sessionHome)).toBe(false);
  });

  it('appends downloaded attachments to existing prompt parts', async () => {
    const prompt: WrapperPromptRequest = {
      message: {
        id: 'msg_018f1e2d3c4bPartsAAAAAAA',
        parts: [{ type: 'text', text: 'Analyze this diagram' }],
        attachments: [
          {
            filename: 'diagram.png',
            mime: 'image/png',
            signedUrl: 'https://r2.example.com/diagram.png',
            localPath: path.join(tmpDir, 'diagram.png'),
          },
        ],
      },
      session: {
        ingestUrl: 'wss://worker.example.com/sessions/user/agent/ingest',
        workerAuthToken: 'token',
        wrapperRunId: 'wr_test',
        wrapperGeneration: 1,
        wrapperConnectionId: 'conn_test',
      },
    };

    const result = await materializePromptAttachments(prompt, {
      fetch: asFetch(async () => new Response('image-bytes', { status: 200 })),
      writeResponse: async (filePath, response) => {
        await fsp.writeFile(filePath, await response.text());
        return 11;
      },
    });

    expect(result.message.parts).toEqual([
      { type: 'text', text: 'Analyze this diagram' },
      {
        type: 'file',
        mime: 'image/png',
        url: `file://${path.join(tmpDir, 'diagram.png')}`,
        filename: 'diagram.png',
      },
    ]);
    expect(result.message.attachments).toBeUndefined();
  });

  it('materializes PDF attachments as application/pdf file parts', async () => {
    const pdfPath = path.join(tmpDir, 'spec.pdf');
    const prompt: WrapperPromptRequest = {
      message: {
        id: 'msg_pdf',
        prompt: 'Review this specification',
        attachments: [
          {
            filename: 'spec.pdf',
            mime: 'application/pdf',
            signedUrl: 'https://r2.example.com/spec.pdf',
            localPath: pdfPath,
          },
        ],
      },
      session: {
        ingestUrl: 'wss://worker.example.com/sessions/user/agent/ingest',
        workerAuthToken: 'token',
        wrapperRunId: 'wr_test',
        wrapperGeneration: 1,
        wrapperConnectionId: 'conn_test',
      },
    };

    const result = await materializePromptAttachments(prompt, {
      fetch: asFetch(async () => new Response('pdf-bytes', { status: 200 })),
      writeResponse: async (filePath, response) => {
        const bytes = await response.text();
        await fsp.writeFile(filePath, bytes);
        return bytes.length;
      },
    });

    expect(result.message.parts).toEqual([
      { type: 'text', text: 'Review this specification' },
      {
        type: 'file',
        mime: 'application/pdf',
        url: `file://${pdfPath}`,
        filename: 'spec.pdf',
      },
    ]);
  });

  it.each([
    ['notes.md', '# Notes'],
    ['records.csv', 'name,count\nalpha,1'],
  ])('preserves %s materialized as a text/plain file part', async (filename, content) => {
    const localPath = path.join(tmpDir, filename);
    const prompt: WrapperPromptRequest = {
      message: {
        id: 'msg_text',
        prompt: 'Read this document',
        attachments: [
          {
            filename,
            mime: 'text/plain',
            signedUrl: `https://r2.example.com/${filename}`,
            localPath,
          },
        ],
      },
      session: {
        ingestUrl: 'wss://worker.example.com/sessions/user/agent/ingest',
        workerAuthToken: 'token',
        wrapperRunId: 'wr_test',
        wrapperGeneration: 1,
        wrapperConnectionId: 'conn_test',
      },
    };

    const result = await materializePromptAttachments(prompt, {
      fetch: asFetch(async () => new Response(content, { status: 200 })),
      writeResponse: async (filePath, response) => {
        const bytes = await response.text();
        await fsp.writeFile(filePath, bytes);
        return bytes.length;
      },
    });

    expect(result.message.parts).toContainEqual({
      type: 'file',
      mime: 'text/plain',
      url: `file://${localPath}`,
      filename,
    });
  });

  it('rejects attachments with an oversized content-length before writing', async () => {
    const localPath = path.join(tmpDir, 'too-large.pdf');
    const writeResponse = mock(async () => 0);
    const prompt: WrapperPromptRequest = {
      message: {
        id: 'msg_header_limit',
        prompt: 'Read this PDF',
        attachments: [
          {
            filename: 'too-large.pdf',
            mime: 'application/pdf',
            signedUrl: 'https://r2.example.com/too-large.pdf',
            localPath,
          },
        ],
      },
      session: {
        ingestUrl: 'wss://worker.example.com/sessions/user/agent/ingest',
        workerAuthToken: 'token',
        wrapperRunId: 'wr_test',
        wrapperGeneration: 1,
        wrapperConnectionId: 'conn_test',
      },
    };

    let error: Error | undefined;
    try {
      await materializePromptAttachments(prompt, {
        fetch: asFetch(
          async () =>
            new Response('not-written', {
              status: 200,
              headers: { 'content-length': '5242881' },
            })
        ),
        writeResponse,
      });
    } catch (caught) {
      error = caught instanceof Error ? caught : new Error(String(caught));
    }

    expect(error?.message).toBe('Attachment too large: too-large.pdf');
    expect(writeResponse).not.toHaveBeenCalled();
    expect(fs.existsSync(localPath)).toBe(false);
  });
});
