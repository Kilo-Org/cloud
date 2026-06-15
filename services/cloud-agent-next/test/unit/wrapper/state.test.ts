import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WrapperState } from '../../../wrapper/src/state.js';

const config = { autoCommit: false, condenseOnComplete: false };

describe('WrapperState sealed batch', () => {
  let state: WrapperState;

  beforeEach(() => {
    state = new WrapperState();
  });

  it('tracks exact admitted membership and latest admitted finalization config', () => {
    state.acceptMessage('message-1', { ...config, autoCommit: true, model: 'first-model' });
    state.acceptMessage('message-2', {
      ...config,
      condenseOnComplete: true,
      model: 'latest-model',
    });

    expect(state.pendingMessageIds).toEqual(['message-1', 'message-2']);
    expect(state.batchFinalizationConfig).toEqual({
      autoCommit: false,
      condenseOnComplete: true,
      model: 'latest-model',
    });
  });

  it('guards finalization while a delivery acknowledgement is in flight', () => {
    state.acceptMessage('message-1', config);
    expect(state.beginDeliveryAcknowledgement()).toBe(true);

    expect(state.beginFinalizing()).toBe(false);

    state.endDeliveryAcknowledgement();
    expect(state.beginFinalizing()).toBe(true);
    expect(state.beginDeliveryAcknowledgement()).toBe(false);
  });

  it('keeps admissions blocked when tracked messages are cleared during drain', () => {
    state.blockAdmissions();
    state.clearAllMessages();

    expect(state.beginDeliveryAcknowledgement()).toBe(false);

    state.bindSession({
      kiloSessionId: 'kilo-session',
      ingestUrl: 'ws://worker.test/ingest',
      workerAuthToken: 'worker-token',
    });
    expect(state.beginDeliveryAcknowledgement()).toBe(true);
  });

  it('clears failed admission without changing the prior finalization config', () => {
    state.acceptMessage('message-1', { ...config, autoCommit: true });
    state.acceptMessage('message-2', { ...config, condenseOnComplete: true });

    state.removeMessage('message-2');

    expect(state.pendingMessageIds).toEqual(['message-1']);
    expect(state.batchFinalizationConfig).toEqual({ ...config, autoCommit: true });
  });

  it('reports finalizing status and clears the batch with the session', () => {
    state.bindSession({
      kiloSessionId: 'kilo-session',
      ingestUrl: 'ws://worker.test/ingest',
      workerAuthToken: 'worker-token',
    });
    state.acceptMessage('message-1', config);
    state.beginFinalizing();

    expect(state.getStatus()).toMatchObject({
      state: 'finalizing',
      pendingMessages: ['message-1'],
    });

    state.clearSession();
    expect(state.pendingMessageIds).toEqual([]);
    expect(state.isFinalizing).toBe(false);
  });

  it('sends ingest events through the current sender', () => {
    const send = vi.fn();
    state.setSendToIngestFn(send);
    const event = {
      streamEventType: 'status' as const,
      data: { message: 'test' },
      timestamp: new Date().toISOString(),
    };

    state.sendToIngest(event);

    expect(send).toHaveBeenCalledWith(event);
  });
});
