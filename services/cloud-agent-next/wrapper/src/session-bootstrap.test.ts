import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  materializePromptAttachments,
  prepareWrapperBootstrapWorkspace,
  type WrapperBootstrapDeps,
} from './session-bootstrap';
import type {
  WrapperPromptRequest,
  WrapperSessionReadyRequest,
} from '../../src/shared/wrapper-bootstrap';

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
        KILOCODE_TOKEN: 'kilo-token',
      },
      setupCommands: ['pnpm install'],
      runtimeSkills: [{ name: 'test-skill', rawMarkdown: '# Test Skill' }],
    },
    session: {
      ingestUrl: 'wss://worker.example.com/sessions/user_test/agent/ingest',
      workerAuthToken: 'kilo-token',
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

describe('prepareWrapperBootstrapWorkspace', () => {
  let tmpDir: string;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrapper-bootstrap-'));
    originalEnv = {
      HOME: process.env.HOME,
      KILOCODE_TOKEN: process.env.KILOCODE_TOKEN,
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
    expect(gitCalls[0]).toEqual([
      'clone',
      'https://x-access-token:gh-token@github.com/acme/repo.git',
      request.workspace.workspacePath,
    ]);
    expect(gitCalls.some(args => args.join(' ') === 'checkout -b main')).toBe(true);
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

    expect(gitCalls).toContainEqual(['fetch', 'origin', 'refs/pull/123/head']);
    expect(gitCalls).toContainEqual(['checkout', '-B', 'refs/pull/123/head', 'FETCH_HEAD']);
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

    expect(gitCalls).toContainEqual(['fetch', 'origin', 'refs/merge-requests/99/head']);
    expect(gitCalls).toContainEqual([
      'checkout',
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

  it('still fails fresh cold bootstraps when a setup command fails', async () => {
    const request = makeRequest(tmpDir);
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
      runProcess: async () => ({ stdout: '', stderr: 'install failed', exitCode: 1 }),
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

    expect(setupError.message).toContain('Setup command failed: pnpm install (exit code 1)');
  });

  it('resumes unfinished cold bootstraps when a prior attempt left a git workspace behind', async () => {
    const request = makeRequest(tmpDir);
    await fsp.mkdir(path.join(request.workspace.workspacePath, '.git'), { recursive: true });

    const gitCalls: string[][] = [];
    const setupCalls: string[][] = [];
    const restoreCalls: Array<{ kiloSessionId: string; workspacePath: string; filePath?: string }> =
      [];
    const deps: WrapperBootstrapDeps = {
      git: async args => {
        gitCalls.push(args);
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

    expect(result.workspaceWasWarm).toBe(true);
    expect(gitCalls.some(args => args[0] === 'clone')).toBe(false);
    expect(gitCalls.some(args => args.join(' ') === 'checkout -b main')).toBe(true);
    expect(restoreCalls[0]).toMatchObject({
      kiloSessionId: 'kilo_sess_1',
      workspacePath: request.workspace.workspacePath,
    });
    expect(restoreCalls[0].filePath).toContain('/tmp/kilo-empty-session-kilo_sess_1.json');
    expect(setupCalls).toEqual([['sh', '-lc', 'pnpm install']]);
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
    await fsp.mkdir(path.join(request.workspace.workspacePath, '.git'), { recursive: true });

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
    expect(progress).not.toHaveBeenCalled();
    expect(gitCalls).toEqual([
      ['remote', 'set-url', 'origin', 'https://oauth2:gitlab-token@gitlab.com/acme/repo.git'],
    ]);
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
});
