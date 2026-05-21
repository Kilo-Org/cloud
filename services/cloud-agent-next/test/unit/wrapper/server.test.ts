/**
 * Unit tests for wrapper server command handlers.
 *
 * Tests that session-bound commands (answer-permission, answer-question,
 * reject-question, abort) work when `currentSession` is set.
 */

import { describe, expect, it, vi } from 'vitest';
import { WrapperState } from '../../../wrapper/src/state.js';
import {
  createAnswerPermissionHandler,
  createAnswerQuestionHandler,
  createRejectQuestionHandler,
  createAbortHandler,
  createPromptHandler,
  createSessionReadyHandler,
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
    readySession: vi.fn(),
    materializePromptAttachments: vi.fn(async prompt => prompt),
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
  });

  it('does not mutate state when validation fails', async () => {
    const state = new WrapperState();
    const deps = createMockDeps(state);
    const { wrapperRunId: _, ...bindingWithoutRunId } = completeBinding;
    await bindSessionContext(bindingWithoutRunId as SessionBinding, defaultServerConfig, deps);

    expect(state.hasSession).toBe(false);
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

  it('materializes attachments before opening ingest and sending the prompt', async () => {
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
              mime: 'image/png',
              url: 'file:///tmp/image.png',
              filename: 'image.png',
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
              filename: 'image.png',
              mime: 'image/png',
              signedUrl: 'https://r2.example.com/image.png',
              localPath: '/tmp/image.png',
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
            mime: 'image/png',
            url: 'file:///tmp/image.png',
            filename: 'image.png',
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
