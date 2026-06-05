/**
 * Unit tests for wrapper server command handlers.
 *
 * Tests that session-bound commands (answer-permission, answer-question,
 * reject-question, abort) work when `currentSession` is set.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WrapperState } from '../../../wrapper/src/state.js';
import { configureCommitCoAuthorHook } from '../../../wrapper/src/commit-co-author-hook.js';
import { git } from '../../../wrapper/src/utils.js';
import {
  createAnswerPermissionHandler,
  createAnswerQuestionHandler,
  createRejectQuestionHandler,
  createAbortHandler,
  createPromptHandler,
  createCommandHandler,
  createSessionReadyHandler,
  createKiloProxyHandler,
  isKiloProxyPath,
  bindSessionContext,
  type ServerConfig,
  type SessionBinding,
} from '../../../wrapper/src/server.js';
import type { WrapperKiloClient } from '../../../wrapper/src/kilo-api.js';

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

function createMockKiloClient(): WrapperKiloClient {
  return {
    createSession: vi.fn().mockResolvedValue({ id: 'kilo_sess' }),
    getSession: vi.fn().mockResolvedValue({ id: 'kilo_sess' }),
    sendPromptAsync: vi.fn().mockResolvedValue(undefined),
    abortSession: vi.fn().mockResolvedValue(true),
    summarizeSession: vi.fn().mockResolvedValue(true),
    sendCommand: vi.fn().mockResolvedValue(undefined),
    answerPermission: vi.fn().mockResolvedValue(true),
    answerQuestion: vi.fn().mockResolvedValue(true),
    rejectQuestion: vi.fn().mockResolvedValue(true),
    generateCommitMessage: vi.fn().mockResolvedValue({ message: 'test commit' }),
    getSessionStatuses: vi.fn().mockResolvedValue({}),
    getQuestions: vi.fn().mockResolvedValue([]),
    getPermissions: vi.fn().mockResolvedValue([]),
    subscribeEvents: vi.fn().mockResolvedValue({ stream: undefined }),
    serverUrl: 'http://127.0.0.1:0',
  };
}

function createMockDeps(state: WrapperState) {
  return {
    state,
    kiloClient: createMockKiloClient(),
    openConnection: vi.fn().mockResolvedValue(undefined),
    closeConnection: vi.fn().mockResolvedValue(undefined),
    setAborted: vi.fn(),
    resetLifecycle: vi.fn(),
    onMessageComplete: vi.fn(),
    readySession: vi.fn(),
    materializePromptAttachments: vi.fn(async prompt => prompt),
    configureCommitCoAuthor: vi.fn().mockResolvedValue(undefined),
    onSessionBound: vi.fn(),
  };
}

function jsonRequest(body: unknown): Request {
  return new Request('http://localhost/job/endpoint', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function readJson(response: Response): Promise<unknown> {
  return response.json();
}

const createdRepos: string[] = [];
const BOT_CO_AUTHOR = {
  name: 'kiloconnect[bot]',
  email: '240665456+kiloconnect[bot]@users.noreply.github.com',
};
const BOT_CO_AUTHOR_TRAILER =
  'Co-authored-by: kiloconnect[bot] <240665456+kiloconnect[bot]@users.noreply.github.com>';

async function createRepo(): Promise<string> {
  const repoPath = await mkdtemp(join(tmpdir(), 'wrapper-server-commit-co-author-'));
  createdRepos.push(repoPath);
  await git(['init'], { cwd: repoPath, timeoutMs: 5_000 });
  await git(['config', 'user.email', 'author@example.com'], { cwd: repoPath, timeoutMs: 5_000 });
  await git(['config', 'user.name', 'Author'], { cwd: repoPath, timeoutMs: 5_000 });
  return repoPath;
}

afterEach(async () => {
  await Promise.all(
    createdRepos.splice(0).map(repoPath => rm(repoPath, { recursive: true, force: true }))
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Kilo Proxy Handler
// ---------------------------------------------------------------------------

describe('createKiloProxyHandler', () => {
  it('matches only the wrapper kilo proxy path family', () => {
    expect(isKiloProxyPath('/kilo-proxy')).toBe(true);
    expect(isKiloProxyPath('/kilo-proxy/session/ses_123/message')).toBe(true);
    expect(isKiloProxyPath('/health')).toBe(false);
    expect(isKiloProxyPath('/job/status')).toBe(false);
  });

  it('forwards path and query to the private Kilo server', async () => {
    const state = new WrapperState();
    const deps = createMockDeps(state);
    const fetchMock = vi.fn(async () => new Response('proxied'));
    vi.stubGlobal('fetch', fetchMock);
    const handler = createKiloProxyHandler(deps);

    await handler(
      new Request('http://wrapper/kilo-proxy/session/ses_123/message?cursor=abc', {
        method: 'GET',
      })
    );

    const upstreamRequest = fetchMock.mock.calls[0][0] as Request;
    const upstreamUrl = new URL(upstreamRequest.url);
    expect(upstreamUrl.origin).toBe('http://127.0.0.1:0');
    expect(upstreamUrl.pathname).toBe('/session/ses_123/message');
    expect(upstreamUrl.search).toBe('?cursor=abc');
  });

  it('preserves mutating methods, JSON bodies, and safe request headers', async () => {
    const state = new WrapperState();
    const deps = createMockDeps(state);
    const fetchMock = vi.fn(async () => new Response('proxied'));
    vi.stubGlobal('fetch', fetchMock);
    const handler = createKiloProxyHandler(deps);

    await handler(
      new Request('http://wrapper/kilo-proxy/session/ses_123', {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer should-not-forward',
          Cookie: 'session=secret',
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ title: 'Updated' }),
      })
    );

    const upstreamRequest = fetchMock.mock.calls[0][0] as Request;
    expect(upstreamRequest.method).toBe('PATCH');
    expect(upstreamRequest.headers.get('authorization')).toBeNull();
    expect(upstreamRequest.headers.get('cookie')).toBeNull();
    expect(upstreamRequest.headers.get('content-type')).toBe('application/json');
    expect(upstreamRequest.headers.get('accept')).toBe('application/json');
    await expect(upstreamRequest.text()).resolves.toBe('{"title":"Updated"}');
  });

  it('passes upstream status, headers, and body through without JSON parsing', async () => {
    const state = new WrapperState();
    const deps = createMockDeps(state);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('plain upstream error', {
            status: 500,
            headers: { 'X-Kilo-Upstream': 'yes' },
          })
      )
    );
    const handler = createKiloProxyHandler(deps);

    const response = await handler(new Request('http://wrapper/kilo-proxy/session/ses_123'));

    expect(response.status).toBe(500);
    expect(response.headers.get('x-kilo-upstream')).toBe('yes');
    await expect(response.text()).resolves.toBe('plain upstream error');
  });

  it('returns 503 when the private Kilo runtime is unavailable', async () => {
    const state = new WrapperState();
    const deps = createMockDeps(state);
    Object.defineProperty(deps.kiloClient, 'serverUrl', {
      get() {
        throw new Error('Kilo server has not been bootstrapped');
      },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const handler = createKiloProxyHandler(deps);

    const response = await handler(new Request('http://wrapper/kilo-proxy/session/ses_123'));

    expect(response.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Answer Permission
// ---------------------------------------------------------------------------

describe('createAnswerPermissionHandler', () => {
  it('returns NO_SESSION when no session is bound', async () => {
    const state = new WrapperState();
    const deps = createMockDeps(state);
    const handler = createAnswerPermissionHandler(deps);

    const response = await handler(jsonRequest({ permissionId: 'perm_1', response: 'always' }));
    const data = await readJson(response);

    expect(response.status).toBe(400);
    expect(data).toEqual({ error: 'NO_SESSION', message: 'No session context' });
  });

  it('works with currentSession', async () => {
    const state = new WrapperState();
    state.bindSession({
      kiloSessionId: 'kilo_sess_1',
      ingestUrl: 'wss://ingest.example.com',
      ingestToken: 'token',
      workerAuthToken: 'auth',
    });
    const deps = createMockDeps(state);
    const handler = createAnswerPermissionHandler(deps);

    const response = await handler(jsonRequest({ permissionId: 'perm_1', response: 'always' }));
    const data = await readJson(response);

    expect(response.status).toBe(200);
    expect(data).toEqual({ status: 'answered', success: true });
    expect(deps.kiloClient.answerPermission).toHaveBeenCalledWith('perm_1', 'always');
  });
});

// ---------------------------------------------------------------------------
// Answer Question
// ---------------------------------------------------------------------------

describe('createAnswerQuestionHandler', () => {
  it('returns NO_SESSION when no session is bound', async () => {
    const state = new WrapperState();
    const deps = createMockDeps(state);
    const handler = createAnswerQuestionHandler(deps);

    const response = await handler(jsonRequest({ questionId: 'q_1', answers: [['yes']] }));
    const data = await readJson(response);

    expect(response.status).toBe(400);
    expect(data).toEqual({ error: 'NO_SESSION', message: 'No session context' });
  });

  it('works with currentSession', async () => {
    const state = new WrapperState();
    state.bindSession({
      kiloSessionId: 'kilo_sess_1',
      ingestUrl: 'wss://ingest.example.com',
      ingestToken: 'token',
      workerAuthToken: 'auth',
    });
    const deps = createMockDeps(state);
    const handler = createAnswerQuestionHandler(deps);

    const response = await handler(jsonRequest({ questionId: 'q_1', answers: [['yes']] }));
    const data = await readJson(response);

    expect(response.status).toBe(200);
    expect(data).toEqual({ status: 'answered', success: true });
    expect(deps.kiloClient.answerQuestion).toHaveBeenCalledWith('q_1', [['yes']]);
  });
});

// ---------------------------------------------------------------------------
// Reject Question
// ---------------------------------------------------------------------------

describe('createRejectQuestionHandler', () => {
  it('returns NO_SESSION when no session is bound', async () => {
    const state = new WrapperState();
    const deps = createMockDeps(state);
    const handler = createRejectQuestionHandler(deps);

    const response = await handler(jsonRequest({ questionId: 'q_1' }));
    const data = await readJson(response);

    expect(response.status).toBe(400);
    expect(data).toEqual({ error: 'NO_SESSION', message: 'No session context' });
  });

  it('works with currentSession', async () => {
    const state = new WrapperState();
    state.bindSession({
      kiloSessionId: 'kilo_sess_1',
      ingestUrl: 'wss://ingest.example.com',
      ingestToken: 'token',
      workerAuthToken: 'auth',
    });
    const deps = createMockDeps(state);
    const handler = createRejectQuestionHandler(deps);

    const response = await handler(jsonRequest({ questionId: 'q_1' }));
    const data = await readJson(response);

    expect(response.status).toBe(200);
    expect(data).toEqual({ status: 'rejected', success: true });
    expect(deps.kiloClient.rejectQuestion).toHaveBeenCalledWith('q_1');
  });
});

// ---------------------------------------------------------------------------
// Abort
// ---------------------------------------------------------------------------

describe('createAbortHandler', () => {
  it('returns NO_SESSION when no session is bound', async () => {
    const state = new WrapperState();
    const deps = createMockDeps(state);
    const triggerDrainAndClose = vi.fn();
    const handler = createAbortHandler(deps, triggerDrainAndClose);

    const response = await handler(new Request('http://localhost/job/abort', { method: 'POST' }));
    const data = await readJson(response);

    expect(response.status).toBe(400);
    expect(data).toEqual({ error: 'NO_SESSION', message: 'No active session to abort' });
  });

  it('works with currentSession', async () => {
    const state = new WrapperState();
    state.bindSession({
      kiloSessionId: 'kilo_sess_1',
      ingestUrl: 'wss://ingest.example.com',
      ingestToken: 'token',
      workerAuthToken: 'auth',
      wrapperRunId: 'run_test',
    });
    const deps = createMockDeps(state);
    const triggerDrainAndClose = vi.fn();
    const handler = createAbortHandler(deps, triggerDrainAndClose);

    const response = await handler(new Request('http://localhost/job/abort', { method: 'POST' }));
    const data = await readJson(response);

    expect(response.status).toBe(200);
    expect(data).toEqual({ status: 'aborted' });
    expect(deps.kiloClient.abortSession).toHaveBeenCalledWith({ sessionId: 'kilo_sess_1' });
    expect(deps.setAborted).toHaveBeenCalled();
    expect(triggerDrainAndClose).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Session Binding (bindSessionContext)
// ---------------------------------------------------------------------------

const defaultServerConfig: ServerConfig = {
  port: 5000,
  workspacePath: '/workspace',
  version: '1.0.0',
  sessionId: 'kilo_sess_1',
  agentSessionId: 'agent_sess_1',
  userId: 'user_1',
};

const completeBinding: SessionBinding = {
  ingestUrl: 'wss://worker.example.com/sessions/user1/sess1/ingest',
  ingestToken: 'tok_ingest',
  workerAuthToken: 'tok_auth',
  wrapperRunId: 'wr_abc123',
  wrapperGeneration: 3,
  wrapperConnectionId: 'conn_456',
};

describe('bindSessionContext', () => {
  it('returns NO_SESSION when no binding and no existing session', async () => {
    const state = new WrapperState();
    const deps = createMockDeps(state);
    const result = await bindSessionContext(undefined, defaultServerConfig, deps);

    expect(result).not.toBeNull();
    expect(result!.status).toBe(400);
    const data = await result!.json();
    expect(data).toEqual({
      error: 'NO_SESSION',
      message: 'No session context and no binding provided',
    });
  });

  it('returns null when no binding but existing session is present', async () => {
    const state = new WrapperState();
    state.bindSession({
      kiloSessionId: 'kilo_sess_1',
      ingestUrl: 'wss://ingest.example.com',
      ingestToken: 'token',
      workerAuthToken: 'auth',
    });
    const deps = createMockDeps(state);
    const result = await bindSessionContext(undefined, defaultServerConfig, deps);

    expect(result).toBeNull();
  });

  it('returns INVALID_REQUEST when binding is missing wrapperRunId', async () => {
    const state = new WrapperState();
    const deps = createMockDeps(state);
    const { wrapperRunId: _, ...bindingWithoutRunId } = completeBinding;
    const result = await bindSessionContext(
      bindingWithoutRunId as SessionBinding,
      defaultServerConfig,
      deps
    );

    expect(result).not.toBeNull();
    expect(result!.status).toBe(400);
    const data = await result!.json();
    expect(data.error).toBe('INVALID_REQUEST');
    expect(data.message).toContain('wrapperRunId');
  });

  it('returns INVALID_REQUEST when binding is missing wrapperGeneration', async () => {
    const state = new WrapperState();
    const deps = createMockDeps(state);
    const { wrapperGeneration: _, ...bindingWithoutGeneration } = completeBinding;
    const result = await bindSessionContext(
      bindingWithoutGeneration as SessionBinding,
      defaultServerConfig,
      deps
    );

    expect(result).not.toBeNull();
    expect(result!.status).toBe(400);
    const data = await result!.json();
    expect(data.error).toBe('INVALID_REQUEST');
    expect(data.message).toContain('wrapperGeneration');
  });

  it('returns INVALID_REQUEST when binding is missing wrapperConnectionId', async () => {
    const state = new WrapperState();
    const deps = createMockDeps(state);
    const { wrapperConnectionId: _, ...bindingWithoutConnId } = completeBinding;
    const result = await bindSessionContext(
      bindingWithoutConnId as SessionBinding,
      defaultServerConfig,
      deps
    );

    expect(result).not.toBeNull();
    expect(result!.status).toBe(400);
    const data = await result!.json();
    expect(data.error).toBe('INVALID_REQUEST');
    expect(data.message).toContain('wrapperConnectionId');
  });

  it('binds session on fresh wrapper with complete binding', async () => {
    const state = new WrapperState();
    const deps = createMockDeps(state);
    const result = await bindSessionContext(completeBinding, defaultServerConfig, deps);

    expect(result).toBeNull();
    expect(state.hasSession).toBe(true);
    const session = state.currentSession;
    expect(session).not.toBeNull();
    expect(session!.ingestUrl).toBe(completeBinding.ingestUrl);
    expect(session!.workerAuthToken).toBe(completeBinding.workerAuthToken);
    expect(session!.wrapperRunId).toBe(completeBinding.wrapperRunId);
    expect(session!.wrapperGeneration).toBe(completeBinding.wrapperGeneration);
    expect(session!.wrapperConnectionId).toBe(completeBinding.wrapperConnectionId);
    expect(deps.onSessionBound).toHaveBeenCalledOnce();
  });

  it('does not mutate state when validation fails', async () => {
    const state = new WrapperState();
    const deps = createMockDeps(state);
    const { wrapperRunId: _, ...bindingWithoutRunId } = completeBinding;
    await bindSessionContext(bindingWithoutRunId as SessionBinding, defaultServerConfig, deps);

    expect(state.hasSession).toBe(false);
    expect(deps.onSessionBound).not.toHaveBeenCalled();
  });

  it('notifies only when an existing binding changes', async () => {
    const state = new WrapperState();
    const deps = createMockDeps(state);
    await bindSessionContext(completeBinding, defaultServerConfig, deps);
    deps.onSessionBound.mockClear();

    await bindSessionContext(completeBinding, defaultServerConfig, deps);
    expect(deps.onSessionBound).not.toHaveBeenCalled();

    await bindSessionContext(
      {
        ...completeBinding,
        wrapperGeneration: completeBinding.wrapperGeneration + 1,
        wrapperConnectionId: 'conn_789',
      },
      defaultServerConfig,
      deps
    );

    expect(deps.onSessionBound).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Prompt Handler
// ---------------------------------------------------------------------------

describe('createPromptHandler', () => {
  it('returns NO_SESSION on fresh wrapper without session binding', async () => {
    const state = new WrapperState();
    const deps = createMockDeps(state);
    const handler = createPromptHandler(defaultServerConfig, deps);

    const response = await handler(jsonRequest({ message: { id: 'msg_1', prompt: 'Hello' } }));
    const data = await readJson(response);

    expect(response.status).toBe(400);
    expect(data).toEqual({
      error: 'NO_SESSION',
      message: 'No session context and no binding provided',
    });
  });

  it('binds session and accepts prompt with complete binding', async () => {
    const state = new WrapperState();
    const deps = createMockDeps(state);
    const handler = createPromptHandler(defaultServerConfig, deps);

    const response = await handler(
      jsonRequest({
        message: {
          id: 'msg_1',
          prompt: 'Hello',
        },
        session: completeBinding,
      })
    );
    const data = await readJson(response);

    expect(response.status).toBe(200);
    expect(data).toEqual({ status: 'sent', messageId: 'msg_1' });
    expect(state.hasSession).toBe(true);
    expect(deps.openConnection).toHaveBeenCalled();
  });

  it('materializes a PDF before opening ingest and sends its local file part to Kilo', async () => {
    const state = new WrapperState();
    const deps = createMockDeps(state);
    const callOrder: string[] = [];
    deps.materializePromptAttachments.mockImplementation(async prompt => {
      callOrder.push('materialize');
      return {
        ...prompt,
        message: {
          ...prompt.message,
          prompt: undefined,
          attachments: undefined,
          parts: [
            { type: 'text', text: 'Hello' },
            {
              type: 'file',
              mime: 'application/pdf',
              url: 'file:///tmp/brief.pdf',
              filename: 'brief.pdf',
            },
          ],
        },
      };
    });
    deps.openConnection.mockImplementation(async () => {
      callOrder.push('openConnection');
    });
    deps.kiloClient.sendPromptAsync = vi.fn(async () => {
      callOrder.push('sendPrompt');
    });
    const handler = createPromptHandler(defaultServerConfig, deps);

    const response = await handler(
      jsonRequest({
        message: {
          id: 'msg_attachments',
          prompt: 'Hello',
          attachments: [
            {
              filename: 'brief.pdf',
              mime: 'application/pdf',
              signedUrl: 'https://r2.example.com/brief.pdf',
              localPath: '/tmp/brief.pdf',
            },
          ],
        },
        session: completeBinding,
      })
    );

    expect(response.status).toBe(200);
    expect(callOrder).toEqual(['materialize', 'openConnection', 'sendPrompt']);
    expect(deps.kiloClient.sendPromptAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'msg_attachments',
        prompt: undefined,
        parts: [
          { type: 'text', text: 'Hello' },
          {
            type: 'file',
            mime: 'application/pdf',
            url: 'file:///tmp/brief.pdf',
            filename: 'brief.pdf',
          },
        ],
      })
    );
  });

  it('maps grouped agent and finalization fields into Kilo prompt and message config', async () => {
    const state = new WrapperState();
    const deps = createMockDeps(state);
    const handler = createPromptHandler(defaultServerConfig, deps);

    const response = await handler(
      jsonRequest({
        message: {
          id: 'msg_grouped',
          prompt: 'Use the selected tools',
        },
        agent: {
          mode: 'code',
          model: { providerID: 'kilo', modelID: 'anthropic/claude-sonnet-4-20250514' },
          variant: 'thinking',
          system: 'You are a helpful assistant',
          tools: { read_file: true, write_file: false },
        },
        finalization: {
          autoCommit: true,
          condenseOnComplete: true,
          commitCoAuthor: { name: 'kiloconnect[bot]', email: 'bot@example.com' },
        },
        session: {
          ...completeBinding,
          upstreamBranch: 'main',
        },
      })
    );

    expect(response.status).toBe(200);
    expect(state.getMessageConfig('msg_grouped')).toEqual({
      autoCommit: true,
      condenseOnComplete: true,
      model: 'anthropic/claude-sonnet-4-20250514',
      upstreamBranch: 'main',
      commitCoAuthor: { name: 'kiloconnect[bot]', email: 'bot@example.com' },
    });
    expect(deps.kiloClient.sendPromptAsync).toHaveBeenCalledWith({
      sessionId: 'kilo_sess_1',
      messageId: 'msg_grouped',
      parts: undefined,
      prompt: 'Use the selected tools',
      variant: 'thinking',
      agent: 'code',
      model: { providerID: 'kilo', modelID: 'anthropic/claude-sonnet-4-20250514' },
      system: 'You are a helpful assistant',
      tools: { read_file: true, write_file: false },
    });
  });

  it('adds the selected bot co-author to direct agent commits before dispatch', async () => {
    const repoPath = await createRepo();
    const state = new WrapperState();
    const deps = createMockDeps(state);
    deps.configureCommitCoAuthor.mockImplementation(configureCommitCoAuthorHook);
    deps.kiloClient.sendPromptAsync = vi.fn(async () => {
      await writeFile(join(repoPath, 'direct.txt'), 'direct\n');
      await git(['add', 'direct.txt'], { cwd: repoPath, timeoutMs: 5_000 });
      const commit = await git(['commit', '--no-verify', '-m', 'Direct agent commit'], {
        cwd: repoPath,
        timeoutMs: 5_000,
      });
      expect(commit.exitCode).toBe(0);
    });
    const handler = createPromptHandler({ ...defaultServerConfig, workspacePath: repoPath }, deps);

    const response = await handler(
      jsonRequest({
        message: { id: 'msg_direct_commit', prompt: 'Commit the change' },
        finalization: { commitCoAuthor: BOT_CO_AUTHOR },
        session: completeBinding,
      })
    );
    const commitMessage = await git(['log', '-1', '--format=%B'], {
      cwd: repoPath,
      timeoutMs: 5_000,
    });

    expect(response.status).toBe(200);
    expect(commitMessage.stdout).toContain(BOT_CO_AUTHOR_TRAILER);
  });

  it('chains existing hooks and suppresses co-authorship when the bot becomes primary author', async () => {
    const repoPath = await createRepo();
    const hooksPath = join(repoPath, '.custom-hooks');
    await mkdir(hooksPath);
    await writeFile(
      join(hooksPath, 'existing-hook-helper'),
      '#!/bin/sh\nprintf "\\nExisting-hook: applied\\n" >> "$1"\n',
      { mode: 0o755 }
    );
    await writeFile(
      join(hooksPath, 'prepare-commit-msg'),
      '#!/bin/sh\n"$(dirname "$0")/existing-hook-helper" "$1"\n',
      { mode: 0o755 }
    );
    await git(['config', '--local', 'core.hooksPath', '.custom-hooks'], {
      cwd: repoPath,
      timeoutMs: 5_000,
    });
    await git(['add', '.custom-hooks'], { cwd: repoPath, timeoutMs: 5_000 });
    await git(['commit', '-m', 'Configure custom hooks'], { cwd: repoPath, timeoutMs: 5_000 });

    const state = new WrapperState();
    const deps = createMockDeps(state);
    deps.configureCommitCoAuthor.mockImplementation(configureCommitCoAuthorHook);
    let commitNumber = 0;
    deps.kiloClient.sendPromptAsync = vi.fn(async () => {
      commitNumber++;
      await writeFile(join(repoPath, `direct-${commitNumber}.txt`), `direct ${commitNumber}\n`);
      await git(['add', `direct-${commitNumber}.txt`], { cwd: repoPath, timeoutMs: 5_000 });
      const commit = await git(['commit', '-m', `Direct commit ${commitNumber}`], {
        cwd: repoPath,
        timeoutMs: 5_000,
      });
      expect(commit.exitCode).toBe(0);
    });
    const handler = createPromptHandler({ ...defaultServerConfig, workspacePath: repoPath }, deps);

    const attributedResponse = await handler(
      jsonRequest({
        message: { id: 'msg_attributed', prompt: 'Commit the attributed change' },
        finalization: { commitCoAuthor: BOT_CO_AUTHOR },
        session: completeBinding,
      })
    );
    const attributedMessage = await git(['log', '-1', '--format=%B'], {
      cwd: repoPath,
      timeoutMs: 5_000,
    });
    const originalHooksStatus = await git(['status', '--porcelain', '--', '.custom-hooks'], {
      cwd: repoPath,
      timeoutMs: 5_000,
    });
    await git(['config', 'user.name', BOT_CO_AUTHOR.name], { cwd: repoPath, timeoutMs: 5_000 });
    await git(['config', 'user.email', BOT_CO_AUTHOR.email], { cwd: repoPath, timeoutMs: 5_000 });

    const fallbackResponse = await handler(
      jsonRequest({
        message: { id: 'msg_fallback', prompt: 'Commit using bot fallback' },
        session: completeBinding,
      })
    );
    const fallbackMessage = await git(['log', '-1', '--format=%B'], {
      cwd: repoPath,
      timeoutMs: 5_000,
    });
    const configuredHooksPath = await git(['config', '--local', '--get', 'core.hooksPath'], {
      cwd: repoPath,
      timeoutMs: 5_000,
    });

    expect(attributedResponse.status).toBe(200);
    expect(attributedMessage.stdout).toContain(BOT_CO_AUTHOR_TRAILER);
    expect(attributedMessage.stdout).toContain('Existing-hook: applied');
    expect(originalHooksStatus.stdout).toBe('');
    expect(fallbackResponse.status).toBe(200);
    expect(fallbackMessage.stdout).not.toContain(BOT_CO_AUTHOR_TRAILER);
    expect(fallbackMessage.stdout).toContain('Existing-hook: applied');
    expect(configuredHooksPath.stdout.trim()).toContain('kilo-managed-hooks');
  });

  it('keeps repository pre-commit hooks active while adding co-authorship', async () => {
    const repoPath = await createRepo();
    const hooksPath = join(repoPath, '.custom-hooks');
    await mkdir(hooksPath);
    await writeFile(join(hooksPath, 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    await git(['config', '--local', 'core.hooksPath', '.custom-hooks'], {
      cwd: repoPath,
      timeoutMs: 5_000,
    });

    const state = new WrapperState();
    const deps = createMockDeps(state);
    deps.configureCommitCoAuthor.mockImplementation(configureCommitCoAuthorHook);
    let commitExitCode: number | undefined;
    deps.kiloClient.sendPromptAsync = vi.fn(async () => {
      await writeFile(join(repoPath, 'blocked.txt'), 'blocked\n');
      await git(['add', 'blocked.txt'], { cwd: repoPath, timeoutMs: 5_000 });
      const commit = await git(['commit', '-m', 'Blocked commit'], {
        cwd: repoPath,
        timeoutMs: 5_000,
      });
      commitExitCode = commit.exitCode;
    });
    const handler = createPromptHandler({ ...defaultServerConfig, workspacePath: repoPath }, deps);

    const response = await handler(
      jsonRequest({
        message: { id: 'msg_pre_commit', prompt: 'Commit the blocked change' },
        finalization: { commitCoAuthor: BOT_CO_AUTHOR },
        session: completeBinding,
      })
    );

    expect(response.status).toBe(200);
    expect(commitExitCode).not.toBe(0);
  });

  it('delegates repository hooks created after attribution is configured', async () => {
    const repoPath = await createRepo();
    const hooksPath = join(repoPath, '.custom-hooks');
    await mkdir(hooksPath);
    await git(['config', '--local', 'core.hooksPath', '.custom-hooks'], {
      cwd: repoPath,
      timeoutMs: 5_000,
    });

    const state = new WrapperState();
    const deps = createMockDeps(state);
    deps.configureCommitCoAuthor.mockImplementation(configureCommitCoAuthorHook);
    let commitExitCode: number | undefined;
    deps.kiloClient.sendPromptAsync = vi.fn(async () => {
      await writeFile(join(hooksPath, 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      await writeFile(join(repoPath, 'late-hook.txt'), 'late hook\n');
      await git(['add', 'late-hook.txt'], { cwd: repoPath, timeoutMs: 5_000 });
      const commit = await git(['commit', '-m', 'Blocked by newly added hook'], {
        cwd: repoPath,
        timeoutMs: 5_000,
      });
      commitExitCode = commit.exitCode;
    });
    const handler = createPromptHandler({ ...defaultServerConfig, workspacePath: repoPath }, deps);

    const response = await handler(
      jsonRequest({
        message: { id: 'msg_late_hook', prompt: 'Create a hook then commit' },
        finalization: { commitCoAuthor: BOT_CO_AUTHOR },
        session: completeBinding,
      })
    );

    expect(response.status).toBe(200);
    expect(commitExitCode).not.toBe(0);
  });

  it('fails closed when managed hook state is missing from an active private hook path', async () => {
    const repoPath = await createRepo();
    const gitDirectory = await git(['rev-parse', '--absolute-git-dir'], {
      cwd: repoPath,
      timeoutMs: 5_000,
    });
    const managedHooksPath = join(gitDirectory.stdout.trim(), 'kilo-managed-hooks');
    await git(['config', '--local', 'core.hooksPath', managedHooksPath], {
      cwd: repoPath,
      timeoutMs: 5_000,
    });

    await expect(configureCommitCoAuthorHook(repoPath, BOT_CO_AUTHOR)).rejects.toThrow(
      'Managed git hook state is missing'
    );
    const configuredHooksPath = await git(['config', '--local', '--get', 'core.hooksPath'], {
      cwd: repoPath,
      timeoutMs: 5_000,
    });
    expect(configuredHooksPath.stdout.trim()).toBe(managedHooksPath);
  });

  it('rejects the old flat prompt body', async () => {
    const state = new WrapperState();
    const deps = createMockDeps(state);
    const handler = createPromptHandler(defaultServerConfig, deps);

    const response = await handler(
      jsonRequest({
        prompt: 'Hello',
        messageId: 'msg_legacy',
        session: completeBinding,
      })
    );
    const data = await readJson(response);

    expect(response.status).toBe(400);
    expect(data).toEqual({
      error: 'INVALID_REQUEST',
      message: 'message.id is required',
    });
    expect(deps.kiloClient.sendPromptAsync).not.toHaveBeenCalled();
  });

  it('rejects prompt with incomplete session binding', async () => {
    const state = new WrapperState();
    const deps = createMockDeps(state);
    const handler = createPromptHandler(defaultServerConfig, deps);

    const { wrapperRunId: _, ...incompleteBinding } = completeBinding;

    const response = await handler(
      jsonRequest({
        message: {
          id: 'msg_1',
          prompt: 'Hello',
        },
        session: incompleteBinding,
      })
    );

    expect(response.status).toBe(400);
    expect(state.hasSession).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Command Handler
// ---------------------------------------------------------------------------

describe('createCommandHandler', () => {
  it('routes compact through session summarize with the selected model', async () => {
    const state = new WrapperState();
    const sendToIngest = vi.fn();
    state.setSendToIngestFn(sendToIngest);
    const deps = createMockDeps(state);
    const handler = createCommandHandler(defaultServerConfig, deps);

    const response = await handler(
      jsonRequest({
        command: 'compact',
        messageId: 'msg_compact',
        agent: {
          model: { providerID: 'kilo', modelID: 'anthropic/claude-sonnet-4-20250514' },
        },
        session: completeBinding,
      })
    );
    const data = await readJson(response);

    expect(response.status).toBe(200);
    expect(data).toEqual({ status: 'sent', result: true });
    expect(deps.openConnection).toHaveBeenCalledOnce();
    expect(deps.kiloClient.summarizeSession).toHaveBeenCalledWith({
      sessionId: 'kilo_sess_1',
      model: { providerID: 'kilo', modelID: 'anthropic/claude-sonnet-4-20250514' },
    });
    expect(deps.kiloClient.sendCommand).not.toHaveBeenCalled();
    expect(sendToIngest).toHaveBeenCalledWith({
      streamEventType: 'cloud.message.completed',
      data: {
        messageId: 'msg_compact',
        completionSource: 'manual_compact_summarize',
      },
      timestamp: expect.any(String),
    });
    expect(deps.onMessageComplete).toHaveBeenCalledWith('msg_compact');
    expect(state.getMessageConfig('msg_compact')).toEqual({
      autoCommit: false,
      condenseOnComplete: false,
      model: 'anthropic/claude-sonnet-4-20250514',
      upstreamBranch: undefined,
    });
  });

  it('rejects compact without a model', async () => {
    const state = new WrapperState();
    const deps = createMockDeps(state);
    const handler = createCommandHandler(defaultServerConfig, deps);

    const response = await handler(
      jsonRequest({
        command: 'compact',
        messageId: 'msg_compact',
        session: completeBinding,
      })
    );
    const data = await readJson(response);

    expect(response.status).toBe(400);
    expect(data).toEqual({ error: 'INVALID_REQUEST', message: 'model is required for compact' });
    expect(deps.openConnection).not.toHaveBeenCalled();
    expect(deps.kiloClient.summarizeSession).not.toHaveBeenCalled();
    expect(deps.kiloClient.sendCommand).not.toHaveBeenCalled();
  });

  it('does not complete compact message when summarize fails', async () => {
    const state = new WrapperState();
    const sendToIngest = vi.fn();
    state.setSendToIngestFn(sendToIngest);
    const deps = createMockDeps(state);
    deps.kiloClient.summarizeSession = vi.fn().mockRejectedValue(new Error('summarize failed'));
    const handler = createCommandHandler(defaultServerConfig, deps);

    const response = await handler(
      jsonRequest({
        command: 'compact',
        messageId: 'msg_compact',
        agent: {
          model: { providerID: 'kilo', modelID: 'anthropic/claude-sonnet-4-20250514' },
        },
        session: completeBinding,
      })
    );
    const data = await readJson(response);

    expect(response.status).toBe(500);
    expect(data).toEqual({
      error: 'COMMAND_ERROR',
      message: 'Failed to send command: summarize failed',
    });
    expect(sendToIngest).not.toHaveBeenCalled();
    expect(deps.onMessageComplete).not.toHaveBeenCalled();
    expect(state.getMessageConfig('msg_compact')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Session Ready Handler
// ---------------------------------------------------------------------------

describe('createSessionReadyHandler', () => {
  it('delegates readiness to the wrapper runtime', async () => {
    const state = new WrapperState();
    const deps = createMockDeps(state);
    deps.readySession.mockResolvedValue({
      status: 'ready',
      kiloSessionId: 'kilo_sess_1',
      workspaceReady: {
        workspacePath: '/workspace',
        sandboxId: 'usr-test',
        sessionHome: '/home/agent_test',
        branchName: 'main',
        kiloSessionId: 'kilo_sess_1',
      },
    });
    const handler = createSessionReadyHandler(deps);

    const response = await handler(
      jsonRequest({
        agentSessionId: 'agent_test',
        userId: 'user_test',
        sandboxId: 'usr-test',
        kiloSessionId: 'kilo_sess_1',
        workspace: {
          workspacePath: '/workspace',
          sessionHome: '/home/agent_test',
          branchName: 'main',
        },
        materialized: { env: { KILOCODE_TOKEN: 'kilo-token' } },
        session: completeBinding,
      })
    );
    const data = await readJson(response);

    expect(response.status).toBe(200);
    expect(data).toMatchObject({
      status: 'ready',
      kiloSessionId: 'kilo_sess_1',
    });
    expect(deps.readySession).toHaveBeenCalledOnce();
  });

  it('maps typed bootstrap errors to JSON error responses', async () => {
    const state = new WrapperState();
    const deps = createMockDeps(state);
    deps.readySession.mockResolvedValue({
      status: 'error',
      error: {
        code: 'WORKSPACE_SETUP_FAILED',
        message: 'Failed to clone repository',
        retryable: true,
      },
    });
    const handler = createSessionReadyHandler(deps);

    const response = await handler(
      jsonRequest({
        agentSessionId: 'agent_test',
        userId: 'user_test',
        sandboxId: 'usr-test',
        kiloSessionId: 'kilo_sess_1',
        workspace: {
          workspacePath: '/workspace',
          sessionHome: '/home/agent_test',
          branchName: 'main',
        },
        materialized: { env: { KILOCODE_TOKEN: 'kilo-token' } },
        session: completeBinding,
      })
    );
    const data = await readJson(response);

    expect(response.status).toBe(503);
    expect(data).toEqual({
      error: 'WORKSPACE_SETUP_FAILED',
      message: 'Failed to clone repository',
      retryable: true,
    });
  });
});
