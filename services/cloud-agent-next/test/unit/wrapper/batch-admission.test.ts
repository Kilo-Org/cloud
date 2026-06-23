import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLifecycleManager } from '../../../wrapper/src/lifecycle.js';
import type { WrapperKiloClient } from '../../../wrapper/src/kilo-api.js';
import {
  bindSessionContext,
  createCommandHandler,
  createPromptHandler,
  type ServerConfig,
  type SessionBinding,
} from '../../../wrapper/src/server.js';
import { WrapperState } from '../../../wrapper/src/state.js';

vi.mock('../../../wrapper/src/utils.js', () => ({
  getCurrentBranch: vi.fn().mockResolvedValue('main'),
  logToFile: vi.fn(),
}));

const config: ServerConfig = {
  port: 5000,
  workspacePath: '/workspace',
  version: 'test',
  sessionId: 'kilo_session',
  agentSessionId: 'agent_session',
  userId: 'user',
};

const binding: SessionBinding = {
  ingestUrl: 'ws://worker.test/ingest',
  workerAuthToken: 'worker-token',
  wrapperRunId: 'run_1',
  wrapperGeneration: 1,
  wrapperConnectionId: 'connection_1',
};

function request(body: unknown): Request {
  return new Request('http://wrapper.test/job', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

function createDeps(state: WrapperState) {
  return {
    state,
    kiloClient: {
      sendPromptAsync: vi.fn().mockResolvedValue(undefined),
      sendCommand: vi.fn().mockResolvedValue(undefined),
      summarizeSession: vi.fn().mockResolvedValue(true),
    } as WrapperKiloClient,
    openConnection: vi.fn().mockResolvedValue(undefined),
    closeConnection: vi.fn().mockResolvedValue(undefined),
    setAborted: vi.fn(),
    resetLifecycle: vi.fn(),
    onDeliveryAcknowledged: vi.fn(),
    configureCommitCoAuthor: vi.fn().mockResolvedValue(undefined),
  };
}

describe('wrapper batch admission', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('records only successfully admitted prompts and latest admitted finalization config', async () => {
    const state = new WrapperState();
    const deps = createDeps(state);
    const handler = createPromptHandler(config, deps);

    await handler(
      request({
        message: { id: 'message-1', prompt: 'first' },
        finalization: { autoCommit: true },
        session: binding,
      })
    );
    await handler(
      request({
        message: { id: 'message-2', prompt: 'second' },
        finalization: { condenseOnComplete: true },
        session: binding,
      })
    );

    expect(state.pendingMessageIds).toEqual(['message-1', 'message-2']);
    expect(state.batchFinalizationConfig).toMatchObject({
      autoCommit: false,
      condenseOnComplete: true,
    });
    expect(state.deliveryAcknowledgementsInFlight).toBe(0);
    expect(deps.onDeliveryAcknowledged).toHaveBeenLastCalledWith('async-prompt');
  });

  it('preserves the previously admitted batch when prompt admission fails', async () => {
    const state = new WrapperState();
    const deps = createDeps(state);
    const handler = createPromptHandler(config, deps);

    await handler(request({ message: { id: 'message-1', prompt: 'first' }, session: binding }));
    vi.mocked(deps.kiloClient.sendPromptAsync).mockRejectedValueOnce(new Error('rejected'));

    const response = await handler(
      request({ message: { id: 'message-2', prompt: 'second' }, session: binding })
    );

    expect(response.status).toBe(500);
    expect(state.pendingMessageIds).toEqual(['message-1']);
    expect(state.deliveryAcknowledgementsInFlight).toBe(0);
    expect(deps.onDeliveryAcknowledged).toHaveBeenLastCalledWith('failed');
  });

  it('preserves prior prompt membership and config when its retry fails', async () => {
    const state = new WrapperState();
    const deps = createDeps(state);
    const handler = createPromptHandler(config, deps);

    await handler(
      request({
        message: { id: 'message-1', prompt: 'first' },
        finalization: { autoCommit: true },
        session: binding,
      })
    );
    vi.mocked(deps.kiloClient.sendPromptAsync).mockRejectedValueOnce(new Error('rejected'));

    const response = await handler(
      request({
        message: { id: 'message-1', prompt: 'retry' },
        finalization: { condenseOnComplete: true },
        session: binding,
      })
    );

    expect(response.status).toBe(500);
    expect(state.pendingMessageIds).toEqual(['message-1']);
    expect(state.getMessageConfig('message-1')).toEqual({
      autoCommit: true,
      condenseOnComplete: false,
      upstreamBranch: undefined,
    });
    expect(state.batchFinalizationConfig).toEqual({
      autoCommit: true,
      condenseOnComplete: false,
      upstreamBranch: undefined,
    });
  });

  it('preserves prior command membership and config when its retry fails', async () => {
    const state = new WrapperState();
    const deps = createDeps(state);
    const handler = createCommandHandler(config, deps);

    await handler(
      request({
        command: 'first',
        messageId: 'message-1',
        autoCommit: true,
        session: binding,
      })
    );
    vi.mocked(deps.kiloClient.sendCommand).mockRejectedValueOnce(new Error('rejected'));

    const response = await handler(
      request({
        command: 'retry',
        messageId: 'message-1',
        condenseOnComplete: true,
        session: binding,
      })
    );

    expect(response.status).toBe(500);
    expect(state.pendingMessageIds).toEqual(['message-1']);
    expect(state.getMessageConfig('message-1')).toEqual({
      autoCommit: true,
      condenseOnComplete: false,
      upstreamBranch: undefined,
    });
    expect(state.batchFinalizationConfig).toEqual({
      autoCommit: true,
      condenseOnComplete: false,
      upstreamBranch: undefined,
    });
  });

  it('successful async prompt admission cancels an armed idle candidate until later root idle', async () => {
    vi.useFakeTimers();
    const state = new WrapperState();
    const deps = createDeps(state);
    const sendToIngest = vi.fn();
    state.setSendToIngestFn(sendToIngest);
    await bindSessionContext(binding, config, deps);
    state.acceptMessage('message-1', { autoCommit: false, condenseOnComplete: false });
    const lifecycle = createLifecycleManager(
      { workspacePath: '/workspace' },
      {
        state,
        kiloClient: deps.kiloClient,
        closeConnections: vi.fn().mockResolvedValue(undefined),
        isConnected: () => true,
        reconnectEventSubscription: vi.fn(),
      }
    );
    deps.onDeliveryAcknowledged.mockImplementation(kind => lifecycle.onDeliveryAcknowledged(kind));

    lifecycle.onSessionIdle();
    await vi.advanceTimersByTimeAsync(2_000);

    const response = await createPromptHandler(
      config,
      deps
    )(request({ message: { id: 'message-2', prompt: 'later' }, session: binding }));
    expect(response.status).toBe(200);

    await vi.advanceTimersByTimeAsync(1_001);
    expect(sendToIngest).not.toHaveBeenCalledWith(
      expect.objectContaining({ streamEventType: 'wrapper_finalizing' })
    );

    lifecycle.onSessionIdle();
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.waitFor(() => {
      expect(sendToIngest).toHaveBeenCalledWith(
        expect.objectContaining({ streamEventType: 'complete' })
      );
    });

    expect(sendToIngest).toHaveBeenCalledWith({
      streamEventType: 'complete',
      data: expect.objectContaining({ messageIds: ['message-1', 'message-2'] }),
      timestamp: expect.any(String),
    });
    lifecycle.stop();
  });

  it('preserves root idle observed while async prompt acknowledgement is in flight', async () => {
    vi.useFakeTimers();
    const state = new WrapperState();
    const deps = createDeps(state);
    const sendToIngest = vi.fn();
    state.setSendToIngestFn(sendToIngest);
    await bindSessionContext(binding, config, deps);
    let resolvePrompt: (() => void) | undefined;
    vi.mocked(deps.kiloClient.sendPromptAsync).mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolvePrompt = resolve;
        })
    );
    const lifecycle = createLifecycleManager(
      { workspacePath: '/workspace' },
      {
        state,
        kiloClient: deps.kiloClient,
        closeConnections: vi.fn().mockResolvedValue(undefined),
        isConnected: () => true,
        reconnectEventSubscription: vi.fn(),
      }
    );
    deps.onDeliveryAcknowledged.mockImplementation(kind => lifecycle.onDeliveryAcknowledged(kind));

    const responsePromise = createPromptHandler(
      config,
      deps
    )(request({ message: { id: 'message-1', prompt: 'first' }, session: binding }));
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.kiloClient.sendPromptAsync).toHaveBeenCalledOnce();

    lifecycle.onSessionIdle();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(sendToIngest).not.toHaveBeenCalledWith(
      expect.objectContaining({ streamEventType: 'wrapper_finalizing' })
    );

    resolvePrompt?.();
    await expect(responsePromise).resolves.toMatchObject({ status: 200 });
    await vi.advanceTimersByTimeAsync(3_000);

    await vi.waitFor(() => {
      expect(sendToIngest).toHaveBeenCalledWith(
        expect.objectContaining({ streamEventType: 'complete' })
      );
    });
    lifecycle.stop();
  });

  it('rejects prompt immediately after an unsealed aborted drain starts', async () => {
    vi.useFakeTimers();
    const state = new WrapperState();
    const deps = createDeps(state);
    await bindSessionContext(binding, config, deps);
    const lifecycle = createLifecycleManager(
      { workspacePath: '/workspace' },
      {
        state,
        kiloClient: deps.kiloClient,
        closeConnections: vi.fn().mockResolvedValue(undefined),
        isConnected: () => true,
        reconnectEventSubscription: vi.fn(),
      }
    );

    state.clearAllMessages();
    lifecycle.setAborted();
    lifecycle.triggerDrainAndClose();

    const response = await createPromptHandler(
      config,
      deps
    )(request({ message: { id: 'new-prompt', prompt: 'later' }, session: binding }));

    expect(await response.json()).toMatchObject({
      error: 'WRAPPER_FINALIZING',
      wrapperRunId: 'run_1',
    });
    expect(deps.kiloClient.sendPromptAsync).not.toHaveBeenCalled();
    lifecycle.stop();
  });

  it('continues accepting work after lifecycle monitoring stops for a runtime restart', async () => {
    const state = new WrapperState();
    const deps = createDeps(state);
    await bindSessionContext(binding, config, deps);
    const lifecycle = createLifecycleManager(
      { workspacePath: '/workspace' },
      {
        state,
        kiloClient: deps.kiloClient,
        closeConnections: vi.fn().mockResolvedValue(undefined),
        isConnected: () => true,
        reconnectEventSubscription: vi.fn(),
      }
    );

    lifecycle.stop();

    const response = await createPromptHandler(
      config,
      deps
    )(request({ message: { id: 'post-restart-prompt', prompt: 'continue' }, session: binding }));

    expect(response.status).toBe(200);
    expect(deps.kiloClient.sendPromptAsync).toHaveBeenCalledOnce();
  });

  it('accepts a fresh wrapper run after finalizing clears its session', async () => {
    const state = new WrapperState();
    const deps = createDeps(state);
    await bindSessionContext(binding, config, deps);
    state.blockAdmissions();
    state.clearSession();

    const staleResponse = await createPromptHandler(
      config,
      deps
    )(request({ message: { id: 'stale-prompt', prompt: 'late' }, session: binding }));

    expect(await staleResponse.json()).toMatchObject({
      error: 'WRAPPER_FINALIZING',
      wrapperRunId: 'run_1',
    });
    expect(deps.kiloClient.sendPromptAsync).not.toHaveBeenCalled();

    const freshResponse = await createPromptHandler(
      config,
      deps
    )(
      request({
        message: { id: 'fresh-prompt', prompt: 'later' },
        session: { ...binding, wrapperRunId: 'run_2' },
      })
    );

    expect(freshResponse.status).toBe(200);
    expect(state.currentSession?.wrapperRunId).toBe('run_2');
    expect(state.admissionsBlocked).toBe(false);
    expect(deps.kiloClient.sendPromptAsync).toHaveBeenCalledOnce();
  });

  it('rejects prompt, command, and ordinary rebind while finalizing', async () => {
    const state = new WrapperState();
    const deps = createDeps(state);
    await bindSessionContext(binding, config, deps);
    state.acceptMessage('sealed-message', { autoCommit: false, condenseOnComplete: false });
    expect(state.beginFinalizing()).toBe(true);

    const promptResponse = await createPromptHandler(
      config,
      deps
    )(request({ message: { id: 'new-prompt', prompt: 'later' }, session: binding }));
    const commandResponse = await createCommandHandler(
      config,
      deps
    )(request({ command: 'test', messageId: 'new-command', session: binding }));
    const rebindResponse = await bindSessionContext(binding, config, deps);

    expect(await promptResponse.json()).toMatchObject({
      error: 'WRAPPER_FINALIZING',
      wrapperRunId: 'run_1',
    });
    expect(await commandResponse.json()).toMatchObject({
      error: 'WRAPPER_FINALIZING',
      wrapperRunId: 'run_1',
    });
    expect(await rebindResponse?.json()).toMatchObject({
      error: 'WRAPPER_FINALIZING',
      wrapperRunId: 'run_1',
    });
    expect(deps.kiloClient.sendPromptAsync).not.toHaveBeenCalled();
    expect(deps.kiloClient.sendCommand).not.toHaveBeenCalled();
  });
});
