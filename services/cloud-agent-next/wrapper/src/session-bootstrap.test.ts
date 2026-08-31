import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createLogUploader, type LogUploader } from './log-uploader';
import { createSessionReadyHandler, type ServerDependencies } from './server';
import { WrapperState } from './state';
import type { WrapperKiloClient } from './kilo-api';
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

function makeByteStream(totalBytes: number): ReadableStream<Uint8Array> {
  const chunk = new Uint8Array(64 * 1024);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let pushed = 0;
      while (pushed < totalBytes) {
        const remaining = totalBytes - pushed;
        if (remaining >= chunk.byteLength) {
          controller.enqueue(chunk);
          pushed += chunk.byteLength;
        } else {
          controller.enqueue(chunk.subarray(0, remaining));
          pushed += remaining;
        }
      }
      controller.close();
    },
  });
}

async function createCompleteGitWorkspace(workspacePath: string): Promise<void> {
  const gitPath = path.join(workspacePath, '.git');
  await fsp.mkdir(gitPath, { recursive: true });
  await fsp.writeFile(path.join(gitPath, 'kilo-bootstrap-complete'), 'ready\n');
}

function gitCredentialsPath(sessionHome: string): string {
  return path.join(sessionHome, '.local/share/kilo/cloud-agent/git-credentials');
}

describe('prepareWrapperBootstrapWorkspace', () => {
  let tmpDir: string;
  let originalEnv: Record<string, string | undefined>;
  let originalFetch: typeof fetch;
  const uploaders: LogUploader[] = [];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrapper-bootstrap-'));
    originalFetch = globalThis.fetch;
    originalEnv = {
      HOME: process.env.HOME,
      WRAPPER_LOG_PATH: process.env.WRAPPER_LOG_PATH,
      KILOCODE_TOKEN: process.env.KILOCODE_TOKEN,
      GH_TOKEN: process.env.GH_TOKEN,
      GITLAB_TOKEN: process.env.GITLAB_TOKEN,
      GITLAB_HOST: process.env.GITLAB_HOST,
      [PNPM_STORE_ENV_VAR]: process.env[PNPM_STORE_ENV_VAR],
    };
  });

  afterEach(() => {
    for (const uploader of uploaders.splice(0)) uploader.stop();
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('materializes authoritative credentials before preparing a cold workspace', async () => {
    const request = makeRequest(tmpDir);
    request.materialized.env.GH_TOKEN = 'profile-github-token';
    const credentialsPath = gitCredentialsPath(request.workspace.sessionHome);
    const credentialsDirectory = path.dirname(credentialsPath);
    await fsp.mkdir(credentialsDirectory, { recursive: true });
    await fsp.chmod(credentialsDirectory, 0o777);
    const progress = mock(() => {});
    const gitCalls: string[][] = [];
    const setupCalls: string[][] = [];
    const restoreCalls: Array<{ kiloSessionId: string; workspacePath: string; filePath?: string }> =
      [];
    const deps: WrapperBootstrapDeps = {
      git: async args => {
        gitCalls.push(args);
        if (args[0] === 'clone') {
          expect(await fsp.readFile(credentialsPath, 'utf8')).toBe(
            'protocol=https\nhost=github.com\nusername=x-access-token\npassword=gh-token\n'
          );
          expect((await fsp.stat(credentialsDirectory)).mode & 0o777).toBe(0o700);
          expect((await fsp.stat(credentialsPath)).mode & 0o777).toBe(0o600);
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
      'https://github.com/acme/repo.git',
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
    expect(process.env.GH_TOKEN).toBe('profile-github-token');
  });

  it('uses a blobless partial clone for GitHub/GitLab code review sessions', async () => {
    const request = makeRequest(tmpDir);
    request.materialized.env.KILO_PLATFORM = 'code-review';
    request.materialized.setupCommands = [];

    const gitCalls: string[][] = [];
    await prepareWrapperBootstrapWorkspace(
      request,
      mock(() => {}),
      {
        git: async args => {
          gitCalls.push(args);
          if (args[0] === 'clone') {
            await fsp.mkdir(path.join(request.workspace.workspacePath, '.git'), {
              recursive: true,
            });
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
      }
    );

    // Full history is retained (no --depth); only file blobs are deferred, so
    // incremental `git diff` and merge-base keep working.
    const cloneCall = gitCalls.find(args => args[0] === 'clone');
    expect(cloneCall).toContain('--filter=blob:none');
    expect(cloneCall).not.toContain('--depth');
  });

  it('keeps a full clone (no blobless filter) for Bitbucket review sessions', async () => {
    const request = makeRequest(tmpDir);
    request.materialized.env.KILO_PLATFORM = 'code-review';
    request.materialized.setupCommands = [];
    request.repo = {
      kind: 'git',
      url: 'https://bitbucket.org/acme/repo.git',
      token: 'bb-token',
      platform: 'bitbucket',
    };
    request.workspace.branchName = 'feature/login';

    const gitCalls: string[][] = [];
    await prepareWrapperBootstrapWorkspace(
      request,
      mock(() => {}),
      {
        git: async args => {
          gitCalls.push(args);
          if (args[0] === 'clone') {
            await fsp.mkdir(path.join(request.workspace.workspacePath, '.git'), {
              recursive: true,
            });
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
      }
    );

    // Raw-token Bitbucket is not blobless-eligible; only capability-backed
    // sessions qualify. Origin is still stripped to a credential-free URL.
    const cloneCall = gitCalls.find(args => args[0] === 'clone');
    expect(cloneCall).toContain('https://bitbucket.org/acme/repo.git');
    expect(cloneCall?.join(' ')).not.toContain('bb-token');
    expect(cloneCall).not.toContain('--filter=blob:none');
    expect(gitCalls).toContainEqual([
      'remote',
      'set-url',
      'origin',
      'https://bitbucket.org/acme/repo.git',
    ]);
  });

  it('uses a blobless clone and strips origin to canonical for a contained Bitbucket review session', async () => {
    const request = makeRequest(tmpDir);
    request.materialized.env.KILO_PLATFORM = 'code-review';
    request.materialized.setupCommands = [];
    request.repo = {
      kind: 'git',
      url: 'https://bitbucket.org/acme/repo.git',
      token: 'kbb1.opaque-capability',
      platform: 'bitbucket',
    };
    request.workspace.branchName = 'feature/login';

    const gitCalls: string[][] = [];
    await prepareWrapperBootstrapWorkspace(
      request,
      mock(() => {}),
      {
        git: async args => {
          gitCalls.push(args);
          if (args[0] === 'clone') {
            await fsp.mkdir(path.join(request.workspace.workspacePath, '.git'), {
              recursive: true,
            });
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
      }
    );

    const cloneCall = gitCalls.find(args => args[0] === 'clone');
    expect(cloneCall).toContain('--filter=blob:none');
    expect(cloneCall).toContain('https://bitbucket.org/acme/repo.git');
    expect(cloneCall?.join(' ')).not.toContain('kbb1.');
    expect(gitCalls).toContainEqual([
      'remote',
      'set-url',
      'origin',
      'https://bitbucket.org/acme/repo.git',
    ]);
    expect(await fsp.readFile(gitCredentialsPath(request.workspace.sessionHome), 'utf8')).toBe(
      'protocol=https\nhost=bitbucket.org\nusername=x-token-auth\npassword=kbb1.opaque-capability\n'
    );
  });

  it('uses authoritative credentials for blobless GitLab clones on custom hosts', async () => {
    const request = makeRequest(tmpDir);
    request.materialized.env.KILO_PLATFORM = 'code-review';
    request.materialized.env.GITLAB_TOKEN = 'profile-gitlab-token';
    request.materialized.env.GITLAB_HOST = 'profile.gitlab.example.com';
    request.materialized.setupCommands = [];
    request.repo = {
      kind: 'git',
      url: 'https://gitlab.example.com:8443/acme/repo.git',
      token: 'kgl2.opaque-capability',
      platform: 'gitlab',
    };
    request.workspace.branchName = 'feature/login';

    const gitCalls: string[][] = [];
    await prepareWrapperBootstrapWorkspace(
      request,
      mock(() => {}),
      {
        git: async args => {
          gitCalls.push(args);
          if (args[0] === 'clone') {
            await fsp.mkdir(path.join(request.workspace.workspacePath, '.git'), {
              recursive: true,
            });
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
      }
    );

    const cloneCall = gitCalls.find(args => args[0] === 'clone');
    expect(cloneCall).toContain('--filter=blob:none');
    expect(cloneCall).toContain('https://gitlab.example.com:8443/acme/repo.git');
    expect(cloneCall?.join(' ')).not.toContain('kgl2.opaque-capability');
    expect(await fsp.readFile(gitCredentialsPath(request.workspace.sessionHome), 'utf8')).toBe(
      'protocol=https\nhost=gitlab.example.com:8443\nusername=oauth2\npassword=kgl2.opaque-capability\n'
    );
    expect(process.env.GITLAB_TOKEN).toBe('profile-gitlab-token');
    expect(process.env.GITLAB_HOST).toBe('profile.gitlab.example.com');
  });

  it('keeps a full clone for review sessions on an unrecognized git platform', async () => {
    const request = makeRequest(tmpDir);
    request.materialized.env.KILO_PLATFORM = 'code-review';
    request.materialized.setupCommands = [];
    request.repo = { kind: 'git', url: 'https://git.example.com/acme/repo.git', token: 't' };
    request.workspace.branchName = 'feature/login';

    const gitCalls: string[][] = [];
    await prepareWrapperBootstrapWorkspace(
      request,
      mock(() => {}),
      {
        git: async args => {
          gitCalls.push(args);
          if (args[0] === 'clone') {
            await fsp.mkdir(path.join(request.workspace.workspacePath, '.git'), {
              recursive: true,
            });
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
      }
    );

    const cloneCall = gitCalls.find(args => args[0] === 'clone');
    expect(cloneCall).not.toContain('--filter=blob:none');
    expect(cloneCall).toContain('https://git.example.com/acme/repo.git');
    expect(gitCalls).toContainEqual([
      'remote',
      'set-url',
      'origin',
      'https://git.example.com/acme/repo.git',
    ]);
    expect(await fsp.readFile(gitCredentialsPath(request.workspace.sessionHome), 'utf8')).toBe(
      'protocol=https\nhost=git.example.com\nusername=x-access-token\npassword=t\n'
    );
  });

  it('authenticates GitHub-labeled git sources without GH_TOKEN or URL credentials', async () => {
    const request = makeRequest(tmpDir);
    request.materialized.setupCommands = [];
    request.repo = {
      kind: 'git',
      url: 'https://github.com/Kilo-Org/cloud.git',
      token: 'leftover-github-pat',
      platform: 'github',
    };
    delete request.materialized.env.GH_TOKEN;
    delete process.env.GH_TOKEN;

    const gitCalls: string[][] = [];
    await prepareWrapperBootstrapWorkspace(
      request,
      mock(() => {}),
      {
        git: async args => {
          gitCalls.push(args);
          if (args[0] === 'clone') {
            await fsp.mkdir(path.join(request.workspace.workspacePath, '.git'), {
              recursive: true,
            });
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
      }
    );

    const cloneCall = gitCalls.find(args => args[0] === 'clone');
    expect(cloneCall).toContain('https://github.com/Kilo-Org/cloud.git');
    expect(cloneCall?.join(' ')).not.toContain('leftover-github-pat');
    expect(gitCalls).toContainEqual([
      'remote',
      'set-url',
      'origin',
      'https://github.com/Kilo-Org/cloud.git',
    ]);
    expect(await fsp.readFile(gitCredentialsPath(request.workspace.sessionHome), 'utf8')).toBe(
      'protocol=https\nhost=github.com\nusername=x-access-token\npassword=leftover-github-pat\n'
    );
  });

  it('clones kind:git + platform:github without embedding when GH_TOKEN is present', async () => {
    const request = makeRequest(tmpDir);
    request.materialized.setupCommands = [];
    request.materialized.env.GH_TOKEN = 'leftover-github-pat';
    request.repo = {
      kind: 'git',
      url: 'https://github.com/Kilo-Org/cloud.git',
      token: 'leftover-github-pat',
      platform: 'github',
    };

    const gitCalls: string[][] = [];
    await prepareWrapperBootstrapWorkspace(
      request,
      mock(() => {}),
      {
        git: async args => {
          gitCalls.push(args);
          if (args[0] === 'clone') {
            await fsp.mkdir(path.join(request.workspace.workspacePath, '.git'), {
              recursive: true,
            });
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
      }
    );

    const cloneCall = gitCalls.find(args => args[0] === 'clone');
    expect(cloneCall).toContain('https://github.com/Kilo-Org/cloud.git');
    expect(cloneCall?.join(' ')).not.toContain('leftover-github-pat');
    expect(gitCalls).toContainEqual([
      'remote',
      'set-url',
      'origin',
      'https://github.com/Kilo-Org/cloud.git',
    ]);
  });

  it('uses the current request credential after an earlier request sets GH_TOKEN', async () => {
    const initialRequest = makeRequest(path.join(tmpDir, 'initial'));
    initialRequest.workspace.preferSnapshot = true;
    initialRequest.materialized.setupCommands = [];
    initialRequest.materialized.env.GH_TOKEN = 'previous-github-token';
    await createCompleteGitWorkspace(initialRequest.workspace.workspacePath);

    const fallbackRequest = makeRequest(path.join(tmpDir, 'fallback'));
    fallbackRequest.materialized.setupCommands = [];
    fallbackRequest.repo = {
      kind: 'git',
      url: 'https://github.com/Kilo-Org/cloud.git',
      token: 'current-github-pat',
      platform: 'github',
    };

    const gitCalls: string[][] = [];
    const deps: WrapperBootstrapDeps = {
      git: async args => {
        gitCalls.push(args);
        if (args[0] === 'clone') {
          await fsp.mkdir(path.join(fallbackRequest.workspace.workspacePath, '.git'), {
            recursive: true,
          });
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
    };

    await prepareWrapperBootstrapWorkspace(initialRequest, undefined, deps);
    expect(process.env.GH_TOKEN).toBe('previous-github-token');

    gitCalls.length = 0;
    await prepareWrapperBootstrapWorkspace(fallbackRequest, undefined, deps);

    expect(gitCalls.find(args => args[0] === 'clone')).toContain(
      'https://github.com/Kilo-Org/cloud.git'
    );
    expect(gitCalls).toContainEqual([
      'remote',
      'set-url',
      'origin',
      'https://github.com/Kilo-Org/cloud.git',
    ]);
    expect(
      await fsp.readFile(gitCredentialsPath(fallbackRequest.workspace.sessionHome), 'utf8')
    ).toBe(
      'protocol=https\nhost=github.com\nusername=x-access-token\npassword=current-github-pat\n'
    );
    expect(process.env.GH_TOKEN).toBe('previous-github-token');
  });

  it('preserves anonymous generic HTTPS clones without repository credentials', async () => {
    const request = makeRequest(tmpDir);
    request.materialized.setupCommands = [];
    request.repo = { kind: 'git', url: 'https://git.example.com/acme/public.git' };
    const gitCalls: string[][] = [];

    await prepareWrapperBootstrapWorkspace(request, undefined, {
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
      restoreSession: async () => ({
        ok: true,
        downloaded: false,
        imported: true,
        diffs: { applied: 0, skipped: 0, total: 0 },
      }),
    });

    expect(gitCalls[0]).toEqual([
      'clone',
      '--progress',
      'https://git.example.com/acme/public.git',
      request.workspace.workspacePath,
    ]);
    expect(gitCalls.some(args => args[0] === 'remote' && args[1] === 'set-url')).toBe(false);
    expect(fs.existsSync(gitCredentialsPath(request.workspace.sessionHome))).toBe(false);
  });

  it.each([
    ['newline', 'repository-token\npassword=injected'],
    ['carriage return', 'repository-token\rinjected'],
    ['NUL', 'repository-token\0injected'],
  ])('rejects repository credentials containing a %s before Git runs', async (_kind, token) => {
    const request = makeRequest(tmpDir);
    request.repo = { kind: 'github', repo: 'acme/repo', token };
    const runGit = mock(async () => ({ stdout: '', stderr: '', exitCode: 0 }));

    let readinessError: unknown;
    try {
      await prepareWrapperBootstrapWorkspace(request, undefined, { git: runGit });
    } catch (error) {
      readinessError = error;
    }

    expect(readinessError).toMatchObject({
      code: 'WORKSPACE_SETUP_FAILED',
      subtype: 'workspace_setup_unknown',
      message: 'Workspace setup failed',
    });
    expect(runGit).not.toHaveBeenCalled();
    expect(fs.existsSync(request.workspace.workspacePath)).toBe(false);
    expect(fs.existsSync(request.workspace.sessionHome)).toBe(false);
  });

  it.each(['http://git.example.com/acme/repo.git', 'ssh://git.example.com/acme/repo.git'])(
    'rejects authenticated non-HTTPS repository URL %s before Git runs',
    async url => {
      const request = makeRequest(tmpDir);
      request.repo = { kind: 'git', url, token: 'repository-token' };
      const runGit = mock(async () => ({ stdout: '', stderr: '', exitCode: 0 }));

      let readinessError: unknown;
      try {
        await prepareWrapperBootstrapWorkspace(request, undefined, { git: runGit });
      } catch (error) {
        readinessError = error;
      }

      expect(readinessError).toMatchObject({
        code: 'WORKSPACE_SETUP_FAILED',
        subtype: 'workspace_setup_unknown',
      });
      expect(runGit).not.toHaveBeenCalled();
      expect(fs.existsSync(request.workspace.sessionHome)).toBe(false);
    }
  );

  it('fails warm readiness and removes temporary files when credential replacement fails', async () => {
    const request = makeRequest(tmpDir);
    request.workspace.preferSnapshot = true;
    await createCompleteGitWorkspace(request.workspace.workspacePath);
    const credentialsPath = gitCredentialsPath(request.workspace.sessionHome);
    await fsp.mkdir(credentialsPath, { recursive: true });
    const runGit = mock(async () => ({ stdout: '', stderr: '', exitCode: 0 }));

    let readinessError: unknown;
    try {
      await prepareWrapperBootstrapWorkspace(request, undefined, { git: runGit });
    } catch (error) {
      readinessError = error;
    }

    expect(readinessError).toMatchObject({
      code: 'WORKSPACE_SETUP_FAILED',
      subtype: 'workspace_setup_unknown',
    });
    expect(runGit).not.toHaveBeenCalled();
    expect(await fsp.readdir(path.dirname(credentialsPath))).toEqual(['git-credentials']);
    expect(fs.existsSync(request.workspace.workspacePath)).toBe(true);
  });

  it('retries a full clone when the server rejects the blobless filter', async () => {
    const request = makeRequest(tmpDir);
    request.materialized.env.KILO_PLATFORM = 'code-review';
    request.materialized.setupCommands = [];

    const cloneArgs: string[][] = [];
    await prepareWrapperBootstrapWorkspace(
      request,
      mock(() => {}),
      {
        git: async args => {
          if (args[0] === 'clone') {
            cloneArgs.push(args);
            // Simulate a server that rejects the filter outright (not the
            // warn-and-continue degradation).
            if (args.includes('--filter=blob:none')) {
              return { stdout: '', stderr: 'fatal: filter blob:none not supported', exitCode: 128 };
            }
            await fsp.mkdir(path.join(request.workspace.workspacePath, '.git'), {
              recursive: true,
            });
            return { stdout: '', stderr: '', exitCode: 0 };
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
      }
    );

    expect(cloneArgs.length).toBe(2);
    expect(cloneArgs[0]).toContain('--filter=blob:none');
    expect(cloneArgs[1]).not.toContain('--filter=blob:none');
  });

  it('reports blobless clone telemetry with size proxies parsed from git progress', async () => {
    const request = makeRequest(tmpDir);
    request.materialized.env.KILO_PLATFORM = 'code-review';
    request.materialized.setupCommands = [];

    const result = await prepareWrapperBootstrapWorkspace(
      request,
      mock(() => {}),
      {
        git: async args => {
          if (args[0] === 'clone') {
            await fsp.mkdir(path.join(request.workspace.workspacePath, '.git'), {
              recursive: true,
            });
            return {
              stdout: '',
              stderr: [
                'remote: Enumerating objects: 1234, done.',
                'remote: Total 1234 (delta 456), reused 1000 (delta 300), pack-reused 0',
                'Receiving objects: 100% (1234/1234), 1.50 MiB | 12.34 MiB/s, done.',
              ].join('\n'),
              exitCode: 0,
            };
          }
          if (args[0] === 'rev-parse') {
            return { stdout: '', stderr: '', exitCode: 1 };
          }
          if (args[0] === 'config' && args.includes('remote.origin.promisor')) {
            return { stdout: 'true\n', stderr: '', exitCode: 0 };
          }
          return { stdout: '', stderr: '', exitCode: 0 };
        },
        restoreSession: async () => ({
          ok: true,
          downloaded: false,
          imported: true,
          diffs: { applied: 0, skipped: 0, total: 0 },
        }),
      }
    );

    expect(result.clone?.mode).toBe('blobless');
    expect(result.clone?.attempts).toBe(1);
    expect(result.clone?.filterRejected).toBe(false);
    expect(result.clone?.repoKind).toBe('github');
    expect(result.clone?.repoPlatform).toBe('github');
    expect(result.clone?.shallow).toBe(false);
    expect(result.clone?.totalObjects).toBe(1234);
    expect(result.clone?.receivedBytes).toBe(1.5 * 1024 * 1024);
  });

  it('downgrades to full mode when a blobless clone succeeds but the server silently ignored the filter', async () => {
    const request = makeRequest(tmpDir);
    request.materialized.env.KILO_PLATFORM = 'code-review';
    request.materialized.setupCommands = [];

    const result = await prepareWrapperBootstrapWorkspace(
      request,
      mock(() => {}),
      {
        git: async args => {
          if (args[0] === 'clone') {
            await fsp.mkdir(path.join(request.workspace.workspacePath, '.git'), {
              recursive: true,
            });
            return { stdout: '', stderr: '', exitCode: 0 };
          }
          if (args[0] === 'rev-parse') {
            return { stdout: '', stderr: '', exitCode: 1 };
          }
          if (args[0] === 'config' && args.includes('remote.origin.promisor')) {
            // Server ignored --filter=blob:none: no promisor remote was configured.
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
      }
    );

    expect(result.clone?.mode).toBe('full');
    expect(result.clone?.attempts).toBe(1);
    expect(result.clone?.filterRejected).toBe(false);
  });

  it('reports blobless_fallback telemetry when the server rejects the filter', async () => {
    const request = makeRequest(tmpDir);
    request.materialized.env.KILO_PLATFORM = 'code-review';
    request.materialized.setupCommands = [];

    const result = await prepareWrapperBootstrapWorkspace(
      request,
      mock(() => {}),
      {
        git: async args => {
          if (args[0] === 'clone') {
            if (args.includes('--filter=blob:none')) {
              return { stdout: '', stderr: 'fatal: filter blob:none not supported', exitCode: 128 };
            }
            await fsp.mkdir(path.join(request.workspace.workspacePath, '.git'), {
              recursive: true,
            });
            return { stdout: '', stderr: '', exitCode: 0 };
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
      }
    );

    expect(result.clone?.mode).toBe('blobless_fallback');
    expect(result.clone?.attempts).toBe(2);
    expect(result.clone?.filterRejected).toBe(true);
  });

  it('reports full clone telemetry for sessions that are not blobless eligible', async () => {
    const request = makeRequest(tmpDir);
    request.materialized.env.KILO_PLATFORM = 'code-review';
    request.materialized.setupCommands = [];
    request.repo = {
      kind: 'git',
      url: 'https://bitbucket.org/acme/repo.git',
      token: 'bb-token',
      platform: 'bitbucket',
    };
    request.workspace.branchName = 'feature/login';

    const result = await prepareWrapperBootstrapWorkspace(
      request,
      mock(() => {}),
      {
        git: async args => {
          if (args[0] === 'clone') {
            await fsp.mkdir(path.join(request.workspace.workspacePath, '.git'), {
              recursive: true,
            });
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
      }
    );

    expect(result.clone?.mode).toBe('full');
    expect(result.clone?.attempts).toBe(1);
    expect(result.clone?.filterRejected).toBe(false);
    expect(result.clone?.repoKind).toBe('git');
    expect(result.clone?.repoPlatform).toBe('bitbucket');
    // git reported no progress counters, so the size proxies stay absent
    // rather than defaulting to a misleading zero.
    expect(result.clone?.totalObjects).toBeUndefined();
    expect(result.clone?.receivedBytes).toBeUndefined();
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
            `remote: ${(() => {
              const url = new URL('https://github.com/acme/repo.git');
              url.username = 'x-access-token';
              url.password = 'gh-token';
              return url.toString();
            })()} Receiving objects: 42% (42/100)\n`
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
            expect(fs.existsSync(gitCredentialsPath(request.workspace.sessionHome))).toBe(true);
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

  it.each([
    { stage: 'cold', uploadResult: 'success' },
    { stage: 'cold', uploadResult: 'failure' },
    { stage: 'cold', uploadResult: 'timeout' },
    { stage: 'restored', uploadResult: 'success' },
    { stage: 'restored', uploadResult: 'failure' },
    { stage: 'restored', uploadResult: 'timeout' },
  ])(
    'retains CLI evidence before $stage cleanup with a $uploadResult final upload',
    async ({ stage, uploadResult }) => {
      const request = makeRequest(tmpDir);
      request.workspace.upstreamBranch = 'main';
      request.workspace.restoredFromBackup = stage === 'restored';
      if (stage === 'restored') await createCompleteGitWorkspace(request.workspace.workspacePath);
      const cliLogDir = path.join(request.workspace.sessionHome, '.local/share/kilo/log');
      const cliLogPath = path.join(cliLogDir, 'kilo.log');
      const wrapperLogPath = path.join(tmpDir, 'wrapper.log');
      process.env.WRAPPER_LOG_PATH = wrapperLogPath;
      await fsp.mkdir(cliLogDir, { recursive: true });
      await fsp.writeFile(cliLogPath, 'earlier CLI evidence\n');
      await fsp.writeFile(wrapperLogPath, 'wrapper started\n');

      const archives = new Map<string, string>();
      let uploadCalls = 0;
      let finalUploadSignal: AbortSignal | null | undefined;
      let cliPresentDuringFinalUpload = false;
      let cliPresentAfterFinalUpload = false;
      let beforeCleanupCalls = 0;
      globalThis.fetch = asFetch(async (input, init) => {
        uploadCalls++;
        const url = new URL(input instanceof Request ? input.url : input.toString());
        const archive = gunzipSync(await new Response(init?.body).arrayBuffer()).toString();
        if (uploadCalls === 2) {
          cliPresentDuringFinalUpload = fs.existsSync(cliLogPath);
          finalUploadSignal = init?.signal;
          if (uploadResult === 'failure') {
            throw new Error(`Authorization: Bearer ${request.session.workerAuthToken}`);
          }
          if (uploadResult === 'timeout') return new Promise<Response>(() => {});
          await Bun.sleep(20);
        }
        archives.set(url.pathname, archive);
        return new Response(null, { status: 204 });
      });

      const state = new WrapperState();
      let uploader: LogUploader | undefined;
      let bootstrapError: unknown;
      const deps: ServerDependencies = {
        state,
        kiloClient: {} as WrapperKiloClient,
        openConnection: async () => {},
        closeConnection: async () => {},
        setAborted: () => {},
        resetLifecycle: () => {},
        readySession: async (readyRequest, archiveId) => {
          const attemptUploader = createLogUploader({
            archiveId,
            context: {
              workerBaseUrl: 'https://worker.example.com',
              kiloSessionId: readyRequest.kiloSessionId,
              workerAuthToken: readyRequest.session.workerAuthToken,
            },
            sessionId: readyRequest.agentSessionId,
            userId: readyRequest.userId,
            cliLogDir,
            wrapperLogPath,
          });
          uploader = attemptUploader;
          uploaders.push(attemptUploader);
          state.setLogUploader(attemptUploader);
          attemptUploader.start();
          await attemptUploader.uploadNow();
          try {
            await prepareWrapperBootstrapWorkspace(readyRequest, undefined, {
              git: async args => {
                if (args[0] === 'clone') {
                  await fsp.mkdir(path.join(readyRequest.workspace.workspacePath, '.git'), {
                    recursive: true,
                  });
                }
                if (args[0] === 'fetch') {
                  await fsp.appendFile(cliLogPath, 'final CLI failure evidence\n');
                  return { stdout: '', stderr: '', exitCode: 1 };
                }
                return { stdout: '', stderr: '', exitCode: 0 };
              },
              beforeFailureCleanup: async () => {
                beforeCleanupCalls++;
                await attemptUploader.finalize(uploadResult === 'timeout' ? 100 : 5_000);
                cliPresentAfterFinalUpload = fs.existsSync(cliLogPath);
              },
            });
          } catch (error) {
            bootstrapError = error;
            return {
              status: 'error',
              error: {
                code: workspaceBootstrapErrorCode(error),
                message: 'Workspace preparation failed',
              },
            };
          }
          throw new Error('Expected bootstrap failure');
        },
      };

      const startedAt = Date.now();
      const response = await createSessionReadyHandler(deps)(
        new Request('http://wrapper.test/session/ready', {
          method: 'POST',
          body: JSON.stringify(request),
        })
      );
      const elapsedMs = Date.now() - startedAt;
      if (!uploader) throw new Error('Expected attempt uploader');
      const archivePath = `/sessions/${request.userId}/${request.agentSessionId}/logs/${uploader.archiveId}/logs.tar.gz`;
      const retainedArchive = archives.get(archivePath);
      await uploader.finalize();
      await uploader.uploadNow();

      expect(response.status).toBe(503);
      expect(workspaceBootstrapErrorCode(bootstrapError)).toBe(
        stage === 'restored' ? 'WORKSPACE_RECONCILIATION_FAILED' : 'WORKSPACE_SETUP_FAILED'
      );
      expect(retainedArchive?.includes('earlier CLI evidence')).toBe(true);
      expect(beforeCleanupCalls).toBe(1);
      expect(cliPresentDuringFinalUpload).toBe(true);
      expect(cliPresentAfterFinalUpload).toBe(true);
      expect(fs.existsSync(request.workspace.workspacePath)).toBe(false);
      expect(fs.existsSync(request.workspace.sessionHome)).toBe(false);
      expect(state.logUploader).toBeNull();
      expect(uploadCalls).toBe(2);
      expect(archives.size).toBe(1);
      expect(archives.get(archivePath)).toBe(retainedArchive);
      if (uploadResult === 'success') {
        expect(retainedArchive).toContain('final CLI failure evidence');
      } else {
        expect(retainedArchive).not.toContain('final CLI failure evidence');
      }
      if (uploadResult === 'timeout') {
        expect(finalUploadSignal?.aborted).toBe(true);
        expect(elapsedMs).toBeLessThan(1_500);
      }
      const wrapperLogs = await fsp.readFile(wrapperLogPath, 'utf8');
      expect(wrapperLogs).not.toContain(request.session.workerAuthToken);
      expect(retainedArchive).not.toContain(request.session.workerAuthToken);
      expect(retainedArchive).not.toContain(request.materialized.env.KILOCODE_TOKEN);
    }
  );

  it('still cleans up and preserves the bootstrap error if the pre-cleanup callback throws', async () => {
    const request = makeRequest(tmpDir);
    const wrapperLogPath = path.join(tmpDir, 'wrapper.log');
    process.env.WRAPPER_LOG_PATH = wrapperLogPath;
    let callbackCalls = 0;
    let bootstrapError: unknown;
    try {
      await prepareWrapperBootstrapWorkspace(request, undefined, {
        git: async () => ({ stdout: '', stderr: '', exitCode: 128 }),
        beforeFailureCleanup: () => {
          callbackCalls++;
          throw new Error(`Authorization: Bearer ${request.session.workerAuthToken}`);
        },
      });
    } catch (error) {
      bootstrapError = error;
    }

    expect(callbackCalls).toBe(1);
    expect(bootstrapError).toMatchObject({
      code: 'WORKSPACE_SETUP_FAILED',
      message: 'Repository clone failed',
    });
    expect(fs.existsSync(request.workspace.workspacePath)).toBe(false);
    expect(fs.existsSync(request.workspace.sessionHome)).toBe(false);
    expect(await fsp.readFile(wrapperLogPath, 'utf8')).not.toContain(
      request.session.workerAuthToken
    );
  });

  it('aborts active work and cleans up when the shared workspace deadline expires', async () => {
    const request = makeRequest(tmpDir);
    request.materialized.setupCommands = [];
    let commandSignal: AbortSignal | undefined;
    let caughtError: unknown;

    try {
      await prepareWrapperBootstrapWorkspace(request, undefined, {
        workspacePreparationTimeoutMs: 100,
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

  it('uses pipes and forwards sanitized, redacted setup command output', async () => {
    const request = makeRequest(tmpDir);
    const progress = mock(() => {});
    let setupOptions: Parameters<NonNullable<WrapperBootstrapDeps['runProcess']>>[2];
    let setupInvocation: string[] = [];
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
      runProcess: async (command, args, opts) => {
        setupInvocation = [command, ...args];
        setupOptions = opts;
        markerExistedDuringSetup = fs.existsSync(
          path.join(request.workspace.workspacePath, '.git', 'kilo-bootstrap-complete')
        );
        opts?.onOutput?.('stdout', '\u001b[32mfirst stdout\u001b[0m\nspinner one\r');
        opts?.onOutput?.('stdout', 'spinner two\rdone stdout\npartial stdout');
        opts?.onOutput?.('stderr', 'Authorization: Bearer progress-token\nmeaningful stderr\r\n');
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
    expect(setupInvocation).toEqual(['sh', '-lc', 'pnpm install']);
    expect(markerExistedDuringSetup).toBe(false);
    expect(
      fs.existsSync(path.join(request.workspace.workspacePath, '.git', 'kilo-bootstrap-complete'))
    ).toBe(true);
    expect(progress).toHaveBeenCalledWith({
      type: 'started',
      step: 'setup_commands',
      stepId: 'setup_command:0',
      kind: 'setup_command',
      label: 'Setup command 1',
      command: 'pnpm install',
      commandIndex: 0,
      commandCount: 1,
    });
    expect(progress).toHaveBeenCalledWith({
      type: 'output',
      step: 'setup_commands',
      stepId: 'setup_command:0',
      output: 'first stdout\n',
    });
    expect(progress).toHaveBeenCalledWith({
      type: 'output',
      step: 'setup_commands',
      stepId: 'setup_command:0',
      output: 'done stdout\n',
    });
    expect(progress).toHaveBeenCalledWith({
      type: 'output',
      step: 'setup_commands',
      stepId: 'setup_command:0',
      output: 'partial stdout\n',
    });
    expect(progress).toHaveBeenCalledWith({
      type: 'output',
      step: 'setup_commands',
      stepId: 'setup_command:0',
      output: 'Authorization: Bearer [REDACTED]\nmeaningful stderr\n',
    });
    expect(progress).toHaveBeenCalledWith({
      type: 'completed',
      step: 'setup_commands',
      stepId: 'setup_command:0',
      exitCode: 0,
    });
    const progressText = progress.mock.calls.flat().join('\n');
    expect(progressText).not.toContain('spinner one');
    expect(progressText).not.toContain('spinner two');
    expect(progressText).not.toContain('progress-token');
    expect(progressText).not.toContain('\u001b');
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

  it('fails cold snapshot resumes when a setup command exits nonzero', async () => {
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

    expect(prepareWrapperBootstrapWorkspace(request, undefined, deps)).rejects.toMatchObject({
      code: 'WORKSPACE_SETUP_FAILED',
      subtype: 'setup_command_failed',
      retryable: false,
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
      name: 'clone HTTP 429 rate limit',
      stage: 'clone',
      result: {
        stdout: '',
        stderr:
          "fatal: unable to access 'https://github.com/org/repo.git/': The requested URL returned error: 429",
        exitCode: 128,
      },
      subtype: 'git_rate_limited',
    },
    {
      name: 'clone too many requests rate limit',
      stage: 'clone',
      result: {
        stdout: '',
        stderr: 'fatal: unable to access repository: too many requests',
        exitCode: 128,
      },
      subtype: 'git_rate_limited',
    },
    {
      name: 'clone network failure',
      stage: 'clone',
      result: { stdout: '', stderr: 'fatal: the remote end hung up unexpectedly', exitCode: 128 },
      subtype: 'git_network_failed',
    },
    {
      name: 'clone network failure with progress object counts is not rate limited',
      stage: 'clone',
      result: {
        stdout: '',
        stderr:
          'remote: Enumerating objects: 429, done.\n' +
          'remote: Total 429 (delta 12), reused 100 (delta 30), pack-reused 0\n' +
          'fatal: the remote end hung up unexpectedly',
        exitCode: 128,
      },
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

  it('archives sanitized setup failure details before workspace cleanup', async () => {
    const request = makeRequest(tmpDir);
    request.materialized.setupCommands = ['private-tool --token argv-secret'];
    const cliLogDir = path.join(request.workspace.sessionHome, '.local/share/kilo/log');
    const cliLogPath = path.join(cliLogDir, 'kilo.log');
    const wrapperLogPath = path.join(tmpDir, 'wrapper.log');
    process.env.WRAPPER_LOG_PATH = wrapperLogPath;
    await fsp.mkdir(cliLogDir, { recursive: true });
    await fsp.writeFile(cliLogPath, 'earlier CLI evidence\n');

    let archivedLogs = '';
    let uploadCalls = 0;
    let cliPresentDuringUpload = false;
    globalThis.fetch = asFetch(async (_input, init) => {
      uploadCalls++;
      cliPresentDuringUpload = fs.existsSync(cliLogPath);
      archivedLogs = gunzipSync(await new Response(init?.body).arrayBuffer()).toString();
      return new Response(null, { status: 204 });
    });
    const uploader = createLogUploader({
      archiveId: 'wr_test--setup-failure',
      context: {
        workerBaseUrl: 'https://worker.example.com',
        kiloSessionId: request.kiloSessionId,
        workerAuthToken: request.session.workerAuthToken,
      },
      sessionId: request.agentSessionId,
      userId: request.userId,
      cliLogDir,
      wrapperLogPath,
    });
    uploaders.push(uploader);
    const deps: WrapperBootstrapDeps = {
      beforeFailureCleanup: () => uploader.finalize(),
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
          '\u001b[31mDependency resolution failed\u001b[0m',
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
      retryable: false,
    });
    expect(setupError.message).toBe('Setup command 1 failed');
    const detail = (setupError as { detail?: string }).detail ?? '';
    expect(detail).toContain('command: private-tool --token [REDACTED]');
    expect(detail).toContain('exit code 1');
    expect(detail).toContain('output truncated');
    expect(detail).toContain('output:');
    expect(detail).toContain('https://[REDACTED]@example.com/repo.git');
    expect(detail).toContain('Authorization: Bearer [REDACTED]');
    expect(detail).toContain('Cookie: [REDACTED]');
    expect(detail).toContain('SECRET_VALUE=[REDACTED]');
    expect(detail).toContain('private-file-content');
    expect(detail).toContain('bare-unlabeled-token');
    await uploader.finalize();
    await uploader.uploadNow();
    expect(uploadCalls).toBe(1);
    expect(cliPresentDuringUpload).toBe(true);
    expect(fs.existsSync(request.workspace.workspacePath)).toBe(false);
    expect(fs.existsSync(request.workspace.sessionHome)).toBe(false);
    expect(archivedLogs).toContain('earlier CLI evidence');
    expect(archivedLogs).toContain('subtype=setup_command_failed');
    expect(archivedLogs).toContain(`error=${setupError.message}`);
    expect(archivedLogs).toContain(`detail=${detail}`);
    expect(archivedLogs).toContain('Dependency resolution failed');
    expect(archivedLogs).not.toContain('\u001b');
    const projectedError = JSON.stringify(setupError);
    for (const sensitiveValue of [
      'argv-secret',
      'url-secret',
      'bearer-secret',
      'cookie-secret',
      'env-secret',
      request.session.workerAuthToken,
      request.materialized.env.KILOCODE_TOKEN,
    ]) {
      expect(projectedError).not.toContain(sensitiveValue);
      expect(archivedLogs).not.toContain(sensitiveValue);
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
      retryable: true,
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

  it('continues bootstrap and reports an incomplete cold restore', async () => {
    const request = makeRequest(tmpDir);
    request.workspace.preferSnapshot = true;
    request.materialized.setupCommands = [];
    const progress = mock(() => {});

    const result = await prepareWrapperBootstrapWorkspace(request, progress, {
      git: async args => {
        if (args[0] === 'clone') {
          await fsp.mkdir(path.join(request.workspace.workspacePath, '.git'), { recursive: true });
        }
        if (args[0] === 'rev-parse') {
          return { stdout: '', stderr: '', exitCode: 1 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      restoreSession: async () => ({
        ok: true,
        downloaded: true,
        imported: true,
        diffs: { applied: 1, skipped: 1, total: 2 },
      }),
    });

    expect(result.restore).toEqual({
      path: 'cold',
      diffs: { applied: 1, skipped: 1, total: 2 },
    });
    expect(progress).toHaveBeenCalledWith(
      'kilo_session',
      'Cold restore incomplete, 1/2 files restored'
    );
    expect(progress).toHaveBeenCalledWith('kilo_server', 'Starting Kilo...');
    expect(
      fs.existsSync(path.join(request.workspace.workspacePath, '.git', 'kilo-bootstrap-complete'))
    ).toBe(true);
  });

  it('reports an incomplete backup restore without calling it cold', async () => {
    const request = makeRequest(tmpDir);
    request.workspace.preferSnapshot = true;
    request.workspace.restoredFromBackup = true;
    request.materialized.setupCommands = [];
    await createCompleteGitWorkspace(request.workspace.workspacePath);
    const progress = mock(() => {});

    const result = await prepareWrapperBootstrapWorkspace(request, progress, {
      git: async args => {
        if (args.join(' ') === 'ls-remote --symref origin HEAD') {
          return { stdout: 'ref: refs/heads/main\tHEAD\n', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      restoreSession: async () => ({
        ok: true,
        downloaded: true,
        imported: true,
        diffs: { applied: 1, skipped: 1, total: 2 },
      }),
    });

    expect(result.restore).toEqual({
      path: 'backup',
      diffs: { applied: 1, skipped: 1, total: 2 },
    });
    expect(progress).toHaveBeenCalledWith(
      'kilo_session',
      'Resume restore incomplete, 1/2 files restored'
    );
    expect(progress).not.toHaveBeenCalledWith(
      'kilo_session',
      'Cold restore incomplete, 1/2 files restored'
    );
  });

  it('throws when a required snapshot restore returns 404', async () => {
    const request = makeRequest(tmpDir);
    request.workspace.preferSnapshot = true;
    request.workspace.requireSnapshot = true;
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
            return { stdout: '', stderr: '', exitCode: 1 };
          }
          return { stdout: '', stderr: '', exitCode: 0 };
        },
        restoreSession: async () => ({
          ok: false,
          error: 'snapshot not found (404)',
          code: 404,
          step: 'download',
        }),
      })
    ).rejects.toMatchObject({
      code: 'WORKSPACE_SETUP_FAILED',
      subtype: 'kilo_import_failed',
      retryable: true,
      message: 'Session snapshot required but not found',
    });
  });

  it('returns the restore telemetry when a required snapshot restore succeeds', async () => {
    const request = makeRequest(tmpDir);
    request.workspace.preferSnapshot = true;
    request.workspace.requireSnapshot = true;
    request.materialized.setupCommands = [];

    const result = await prepareWrapperBootstrapWorkspace(request, undefined, {
      git: async args => {
        if (args[0] === 'clone') {
          await fsp.mkdir(path.join(request.workspace.workspacePath, '.git'), {
            recursive: true,
          });
        }
        if (args[0] === 'rev-parse') {
          return { stdout: '', stderr: '', exitCode: 1 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      restoreSession: async () => ({
        ok: true,
        downloaded: true,
        imported: true,
        diffs: { applied: 1, skipped: 0, total: 1 },
      }),
    });

    expect(result.restore).toEqual({
      path: 'cold',
      diffs: { applied: 1, skipped: 0, total: 1 },
    });
  });

  it('falls back to an empty import when a non-required snapshot restore returns 404', async () => {
    const request = makeRequest(tmpDir);
    request.workspace.preferSnapshot = true;
    request.materialized.setupCommands = [];
    const restoreCalls: Array<{ filePath?: string }> = [];

    const result = await prepareWrapperBootstrapWorkspace(request, undefined, {
      git: async args => {
        if (args[0] === 'clone') {
          await fsp.mkdir(path.join(request.workspace.workspacePath, '.git'), {
            recursive: true,
          });
        }
        if (args[0] === 'rev-parse') {
          return { stdout: '', stderr: '', exitCode: 1 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      restoreSession: async (_kiloSessionId, _workspacePath, filePath) => {
        restoreCalls.push({ filePath });
        if (filePath === undefined) {
          return {
            ok: false,
            error: 'snapshot not found (404)',
            code: 404,
            step: 'download',
          };
        }
        return {
          ok: true,
          downloaded: false,
          imported: true,
          diffs: { applied: 0, skipped: 0, total: 0 },
        };
      },
    });

    expect(restoreCalls).toHaveLength(2);
    expect(restoreCalls[0].filePath).toBeUndefined();
    expect(restoreCalls[1].filePath).toContain('/tmp/kilo-empty-session-kilo_sess_1.json');
    expect(result.restore).toEqual({ path: 'cold' });
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

    expect(gitCalls[0]).toContain('https://bitbucket.org/acme/repo.git');
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
    expect(result.restore).toEqual({ path: 'warm' });
    expect(progress).toHaveBeenCalledWith('kilo_session', 'Warm workspace reused');
    expect(progress).toHaveBeenCalledWith('kilo_server', 'Starting Kilo...');
    expect(gitCalls).toEqual([['remote', 'set-url', 'origin', 'https://gitlab.com/acme/repo.git']]);
    expect(await fsp.readFile(rulesPath, 'utf8')).toBe(
      buildCloudAgentRules(request.agentSessionId)
    );
  });

  it('atomically rotates warm credentials without rerunning runtime bootstrap', async () => {
    const request = makeRequest(tmpDir);
    request.workspace.preferSnapshot = true;
    request.materialized.setupCommands = [];
    request.materialized.env.GH_TOKEN = 'profile-github-token';
    const repository = {
      kind: 'github',
      repo: 'acme/repo',
      token: 'initial-repository-token',
    } satisfies NonNullable<WrapperSessionReadyRequest['repo']>;
    request.repo = repository;
    await createCompleteGitWorkspace(request.workspace.workspacePath);
    const credentialsPath = gitCredentialsPath(request.workspace.sessionHome);
    const observedPasswords: string[] = [];
    const deps: WrapperBootstrapDeps = {
      git: async () => {
        const credentials = await fsp.readFile(credentialsPath, 'utf8');
        const password = credentials.split('\n').find(line => line.startsWith('password='));
        if (!password) throw new Error('Missing authoritative repository credential');
        observedPasswords.push(password);
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      runProcess: async () => {
        throw new Error('setup commands should not run when credentials rotate');
      },
      restoreSession: async () => {
        throw new Error('Kilo sessions should not be restored when credentials rotate');
      },
    };

    const initialResult = await prepareWrapperBootstrapWorkspace(request, undefined, deps);
    const previousFile = await fsp.open(credentialsPath, 'r');
    try {
      const previousInode = (await previousFile.stat()).ino;
      repository.token = 'rotated-repository-token';

      const rotatedResult = await prepareWrapperBootstrapWorkspace(request, undefined, deps);

      expect(initialResult.restore).toEqual({ path: 'warm' });
      expect(rotatedResult.restore).toEqual({ path: 'warm' });
      expect((await fsp.stat(credentialsPath)).ino).not.toBe(previousInode);
      expect(await previousFile.readFile('utf8')).toBe(
        'protocol=https\nhost=github.com\nusername=x-access-token\npassword=initial-repository-token\n'
      );
      expect(await fsp.readFile(credentialsPath, 'utf8')).toBe(
        'protocol=https\nhost=github.com\nusername=x-access-token\npassword=rotated-repository-token\n'
      );
      expect(observedPasswords).toEqual([
        'password=initial-repository-token',
        'password=rotated-repository-token',
      ]);
      expect(process.env.GH_TOKEN).toBe('profile-github-token');
    } finally {
      await previousFile.close();
    }
  });

  it('removes stale credentials when a warm generic repository has no token', async () => {
    const request = makeRequest(tmpDir);
    request.workspace.preferSnapshot = true;
    request.materialized.setupCommands = [];
    request.repo = {
      kind: 'git',
      url: 'https://git.example.com/acme/repo.git',
      token: 'stale-repository-token',
    };
    await createCompleteGitWorkspace(request.workspace.workspacePath);
    const gitCalls: string[][] = [];
    const deps: WrapperBootstrapDeps = {
      git: async args => {
        gitCalls.push(args);
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    };

    await prepareWrapperBootstrapWorkspace(request, undefined, deps);
    const credentialsPath = gitCredentialsPath(request.workspace.sessionHome);
    expect(fs.existsSync(credentialsPath)).toBe(true);
    gitCalls.length = 0;
    request.repo = { kind: 'git', url: 'https://git.example.com/acme/repo.git' };

    const result = await prepareWrapperBootstrapWorkspace(request, undefined, deps);

    expect(result.restore).toEqual({ path: 'warm' });
    expect(fs.existsSync(credentialsPath)).toBe(false);
    expect(gitCalls).toEqual([]);
  });

  it('strips a warm Bitbucket leftover origin to the canonical URL', async () => {
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
      ['remote', 'set-url', 'origin', 'https://bitbucket.org/acme/repo.git'],
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
      ['remote', 'set-url', 'origin', 'https://github.com/acme/repo.git'],
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

    expect(events).toContain('git:remote set-url origin https://github.com/acme/repo.git');
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

  it('reconciles restored generic repositories using credentials without a clone fallback', async () => {
    const request = makeRequest(tmpDir);
    request.workspace.branchName = 'session/restored';
    request.workspace.preferSnapshot = true;
    request.workspace.restoredFromBackup = true;
    request.materialized.setupCommands = [];
    request.repo = {
      kind: 'git',
      url: 'https://git.example.com:8443/acme/repo.git',
      token: 'restored-generic-token',
    };
    await createCompleteGitWorkspace(request.workspace.workspacePath);
    const gitCalls: string[][] = [];

    const result = await prepareWrapperBootstrapWorkspace(request, undefined, {
      git: async args => {
        expect(await fsp.readFile(gitCredentialsPath(request.workspace.sessionHome), 'utf8')).toBe(
          'protocol=https\nhost=git.example.com:8443\nusername=x-access-token\npassword=restored-generic-token\n'
        );
        gitCalls.push(args);
        if (args[0] === 'ls-remote') {
          return { stdout: 'ref: refs/heads/main\tHEAD\n', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      restoreSession: async () => ({
        ok: true,
        downloaded: true,
        imported: true,
        diffs: { applied: 0, skipped: 0, total: 0 },
      }),
    });

    expect(result.workspaceWasWarm).toBe(true);
    expect(result.restoredFromBackup).toBe(true);
    expect(result.restore).toEqual({
      path: 'backup',
      diffs: { applied: 0, skipped: 0, total: 0 },
    });
    expect(gitCalls).toEqual([
      ['remote', 'set-url', 'origin', 'https://git.example.com:8443/acme/repo.git'],
      ['ls-remote', '--symref', 'origin', 'HEAD'],
      ['fetch', 'origin', 'main'],
      ['checkout', '-B', 'session/restored', 'FETCH_HEAD'],
    ]);
    expect(gitCalls.flat().join(' ')).not.toContain('restored-generic-token');
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
    expect(await fsp.readFile(path.join(tmpDir, 'diagram.png'), 'utf8')).toBe('image-bytes');
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
    expect(await fsp.readFile(pdfPath, 'utf8')).toBe('pdf-bytes');
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
    });

    expect(result.message.parts).toContainEqual({
      type: 'file',
      mime: 'text/plain',
      url: `file://${localPath}`,
      filename,
    });
    expect(await fsp.readFile(localPath, 'utf8')).toBe(content);
  });

  it('replaces an oversized attachment with an explanatory text part and deletes the partial file', async () => {
    const localPath = path.join(tmpDir, 'too-large.bin');
    const prompt: WrapperPromptRequest = {
      message: {
        id: 'msg_overflow',
        prompt: 'Process this binary',
        attachments: [
          {
            filename: 'too-large.bin',
            mime: 'application/octet-stream',
            signedUrl: 'https://r2.example.com/too-large.bin',
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

    // Stream 21 MiB of bytes (one more than the 20 MiB + 1 cap) so the
    // bounded reader triggers the overflow branch deterministically.
    const total = 21 * 1024 * 1024;
    const chunk = new Uint8Array(64 * 1024);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let pushed = 0;
        while (pushed < total) {
          const remaining = total - pushed;
          if (remaining >= chunk.byteLength) {
            controller.enqueue(chunk);
            pushed += chunk.byteLength;
          } else {
            controller.enqueue(chunk.subarray(0, remaining));
            pushed += remaining;
          }
        }
        controller.close();
      },
    });

    const result = await materializePromptAttachments(prompt, {
      fetch: asFetch(async () => new Response(body, { status: 200 })),
    });

    expect(result.message.parts).toEqual([
      { type: 'text', text: 'Process this binary' },
      {
        type: 'text',
        text: 'attachment too-large.bin could not be retrieved (Attachment too large: bytes exceeded the 20 MiB cap)',
      },
    ]);
    expect(fs.existsSync(localPath)).toBe(false);
  });

  it('materializes a file exactly at the 20 MiB cap as a binary text part', async () => {
    const localPath = path.join(tmpDir, 'exactly-20-mib.bin');
    const prompt: WrapperPromptRequest = {
      message: {
        id: 'msg_exact',
        prompt: 'Process this file',
        attachments: [
          {
            filename: 'exactly-20-mib.bin',
            mime: 'application/octet-stream',
            signedUrl: 'https://r2.example.com/exactly-20-mib.bin',
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
      fetch: asFetch(async () => new Response(makeByteStream(20 * 1024 * 1024), { status: 200 })),
    });

    expect(result.message.parts).toEqual([
      { type: 'text', text: 'Process this file' },
      {
        type: 'text',
        text: `binary attachment saved: filename=exactly-20-mib.bin mime=application/octet-stream size=${20 * 1024 * 1024} path=${localPath}`,
      },
    ]);
    expect(fs.existsSync(localPath)).toBe(true);
  });

  it('rejects a file one byte over the 20 MiB cap and deletes the partial file', async () => {
    const localPath = path.join(tmpDir, 'one-byte-over.bin');
    const prompt: WrapperPromptRequest = {
      message: {
        id: 'msg_over',
        prompt: 'Process this file',
        attachments: [
          {
            filename: 'one-byte-over.bin',
            mime: 'application/octet-stream',
            signedUrl: 'https://r2.example.com/one-byte-over.bin',
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
      fetch: asFetch(
        async () => new Response(makeByteStream(20 * 1024 * 1024 + 1), { status: 200 })
      ),
    });

    expect(result.message.parts).toEqual([
      { type: 'text', text: 'Process this file' },
      {
        type: 'text',
        text: 'attachment one-byte-over.bin could not be retrieved (Attachment too large: bytes exceeded the 20 MiB cap)',
      },
    ]);
    expect(fs.existsSync(localPath)).toBe(false);
  });

  it('deletes the partial file when a mid-transfer read fails', async () => {
    const localPath = path.join(tmpDir, 'interrupted.bin');
    const prompt: WrapperPromptRequest = {
      message: {
        id: 'msg_interrupted',
        prompt: 'Process this file',
        attachments: [
          {
            filename: 'interrupted.bin',
            mime: 'application/octet-stream',
            signedUrl: 'https://r2.example.com/interrupted.bin',
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

    const chunk = new Uint8Array(64 * 1024);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
        controller.error(new Error('stream reset'));
      },
    });

    const result = await materializePromptAttachments(prompt, {
      fetch: asFetch(async () => new Response(body, { status: 200 })),
    });

    expect(result.message.parts).toEqual([
      { type: 'text', text: 'Process this file' },
      {
        type: 'text',
        text: 'attachment interrupted.bin could not be retrieved (stream reset)',
      },
    ]);
    expect(fs.existsSync(localPath)).toBe(false);
  });

  it('continues with text-only parts when a non-2xx response aborts one attachment', async () => {
    const okPath = path.join(tmpDir, 'ok.png');
    const failPath = path.join(tmpDir, 'missing.png');
    const prompt: WrapperPromptRequest = {
      message: {
        id: 'msg_403',
        prompt: 'Show me both',
        attachments: [
          {
            filename: 'missing.png',
            mime: 'image/png',
            signedUrl: 'https://r2.example.com/missing.png',
            localPath: failPath,
          },
          {
            filename: 'ok.png',
            mime: 'image/png',
            signedUrl: 'https://r2.example.com/ok.png',
            localPath: okPath,
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
      fetch: asFetch(async input => {
        const url = typeof input === 'string' ? input : (input as Request).url;
        if (url === 'https://r2.example.com/missing.png') {
          return new Response('forbidden', { status: 403 });
        }
        return new Response('png-bytes', { status: 200 });
      }),
    });

    expect(result.message.parts).toEqual([
      { type: 'text', text: 'Show me both' },
      {
        type: 'text',
        text: 'attachment missing.png could not be retrieved (HTTP 403)',
      },
      {
        type: 'file',
        mime: 'image/png',
        url: `file://${okPath}`,
        filename: 'ok.png',
      },
    ]);
    expect(fs.existsSync(failPath)).toBe(false);
    expect(await fsp.readFile(okPath, 'utf8')).toBe('png-bytes');
  });

  it('converts a network/timeout failure into an explanatory text part and continues', async () => {
    const okPath = path.join(tmpDir, 'ok.json');
    const failPath = path.join(tmpDir, 'bad.json');
    const prompt: WrapperPromptRequest = {
      message: {
        id: 'msg_network',
        prompt: 'Read both',
        attachments: [
          {
            filename: 'bad.json',
            mime: 'text/plain',
            signedUrl: 'https://r2.example.com/bad.json',
            localPath: failPath,
          },
          {
            filename: 'ok.json',
            mime: 'text/plain',
            signedUrl: 'https://r2.example.com/ok.json',
            localPath: okPath,
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
      fetch: asFetch(async input => {
        const url = typeof input === 'string' ? input : (input as Request).url;
        if (url === 'https://r2.example.com/bad.json') {
          throw new Error('socket hang up');
        }
        return new Response('{"ok":true}', { status: 200 });
      }),
    });

    expect(result.message.parts).toEqual([
      { type: 'text', text: 'Read both' },
      {
        type: 'text',
        text: 'attachment bad.json could not be retrieved (socket hang up)',
      },
      {
        type: 'file',
        mime: 'text/plain',
        url: `file://${okPath}`,
        filename: 'ok.json',
      },
    ]);
    expect(fs.existsSync(failPath)).toBe(false);
    expect(await fsp.readFile(okPath, 'utf8')).toBe('{"ok":true}');
  });

  it('materializes a generic binary attachment as a text part describing the saved file', async () => {
    const localPath = path.join(tmpDir, 'payload.zip');
    const prompt: WrapperPromptRequest = {
      message: {
        id: 'msg_zip',
        prompt: 'Extract the archive',
        attachments: [
          {
            filename: 'payload.zip',
            mime: 'application/octet-stream',
            signedUrl: 'https://r2.example.com/payload.zip',
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
      fetch: asFetch(async () => new Response('zip-payload', { status: 200 })),
    });

    expect(result.message.parts).toEqual([
      { type: 'text', text: 'Extract the archive' },
      {
        type: 'text',
        text: `binary attachment saved: filename=payload.zip mime=application/octet-stream size=11 path=${localPath}`,
      },
    ]);
    expect(await fsp.readFile(localPath, 'utf8')).toBe('zip-payload');
  });
});
