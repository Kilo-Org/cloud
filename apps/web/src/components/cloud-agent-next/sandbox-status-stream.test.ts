import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { WebSocketManagerConfig } from '@/lib/cloud-agent/websocket-manager';
import type * as WebSocketManager from '@/lib/cloud-agent/websocket-manager';
import type * as SandboxStatusStream from './sandbox-status-stream';

jest.mock('@/lib/cloud-agent/websocket-manager', () => ({ createWebSocketManager: jest.fn() }));
const { createWebSocketManager } = jest.requireMock<typeof WebSocketManager>(
  '@/lib/cloud-agent/websocket-manager'
);
const { subscribeSandboxStatus } =
  jest.requireActual<typeof SandboxStatusStream>('./sandbox-status-stream');
const createManager = jest.mocked(createWebSocketManager);
const snapshot = {
  status: 'active',
  provider: 'Cloudflare',
  observedAt: 1,
  detailCode: 'sandbox_ready',
  inactivityTimeoutMs: 300_000,
  estimatedSleepAt: 300_001,
};

describe('sandbox status subscription', () => {
  let config: WebSocketManagerConfig;
  const connect = jest.fn();
  const disconnect = jest.fn();
  const getTicket = jest.fn<() => Promise<{ ticket: string; expiresAt: number }>>();
  const onSnapshot = jest.fn();
  const onDisconnected = jest.fn();
  const subscribe = () =>
    subscribeSandboxStatus({
      baseUrl: 'wss://worker.test',
      sessionId: 'workspace_test',
      getTicket,
      onSnapshot,
      onDisconnected,
    });
  const frame = (data: unknown = snapshot) => ({
    eventId: 0,
    executionId: '',
    sessionId: 'workspace_test',
    streamEventType: 'cloud.sandbox.status',
    timestamp: new Date().toISOString(),
    data,
  });

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    getTicket.mockResolvedValue({ ticket: 'single-use-ticket', expiresAt: 100 });
    createManager.mockImplementation(value => {
      config = value;
      return { connect, disconnect, getState: () => ({ status: 'disconnected' }) };
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('requests the authorized status-only route and accepts only validated session snapshots', async () => {
    const dispose = subscribe();
    await Promise.resolve();
    expect(config.url).toBe(
      'wss://worker.test/stream?cloudAgentSessionId=workspace_test&sandboxStatus=true'
    );
    expect(connect).toHaveBeenCalledTimes(1);
    config.onEvent({ ...frame(), sessionId: 'other' });
    config.onEvent({ ...frame(), streamEventType: 'kilocode' });
    expect(onSnapshot).not.toHaveBeenCalled();
    config.onEvent(frame());
    expect(onSnapshot).toHaveBeenCalledWith(snapshot);
    config.onEvent(frame({ ...snapshot, status: 'not-a-status' }));
    expect(onDisconnected).toHaveBeenCalledTimes(1);
    dispose();
  });

  it('invalidates current evidence on disconnect and requires a new snapshot after reconnect', async () => {
    const dispose = subscribe();
    await Promise.resolve();
    config.onEvent(frame());
    config.onStateChange({ status: 'reconnecting', lastEventId: 0, attempt: 1 });
    expect(onDisconnected).toHaveBeenCalledTimes(1);
    config.onStateChange({ status: 'connected', executionId: '' });
    expect(onSnapshot).toHaveBeenCalledTimes(1);
    config.onEvent(
      frame({
        ...snapshot,
        status: 'sleeping',
        detailCode: 'sandbox_stopped',
        estimatedSleepAt: null,
      })
    );
    expect(onSnapshot).toHaveBeenCalledTimes(2);
    await config.onRefreshTicket?.();
    expect(getTicket).toHaveBeenCalledTimes(2);
    dispose();
  });

  it('ignores callbacks and pending tickets after switching sessions or pausing', async () => {
    const dispose = subscribe();
    await Promise.resolve();
    dispose();
    config.onEvent(frame());
    config.onStateChange({ status: 'disconnected' });
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(onDisconnected).not.toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalledTimes(1);
    const ticket = Promise.withResolvers<{ ticket: string; expiresAt: number }>();
    getTicket.mockReturnValue(ticket.promise);
    const stop = subscribe();
    stop();
    ticket.resolve({ ticket: 'late-ticket', expiresAt: 100 });
    await Promise.resolve();
    expect(createManager).toHaveBeenCalledTimes(1);
  });

  it('does not present cached status when ticket acquisition fails', async () => {
    getTicket.mockRejectedValue(new Error('Unauthorized'));
    const dispose = subscribe();
    await Promise.resolve();
    await Promise.resolve();
    expect(onDisconnected).toHaveBeenCalledTimes(1);
    expect(createManager).not.toHaveBeenCalled();
    dispose();
  });

  it('retries failed ticket acquisition with capped backoff and connects after recovery', async () => {
    getTicket.mockRejectedValue(new Error('Temporarily unavailable'));
    const dispose = subscribe();
    await Promise.resolve();
    await Promise.resolve();
    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
      const attempts = getTicket.mock.calls.length;
      await jest.advanceTimersByTimeAsync(delay - 1);
      expect(getTicket).toHaveBeenCalledTimes(attempts);
      await jest.advanceTimersByTimeAsync(1);
      expect(getTicket).toHaveBeenCalledTimes(attempts + 1);
    }
    expect(createManager).not.toHaveBeenCalled();
    getTicket.mockResolvedValue({ ticket: 'recovered-ticket', expiresAt: 100 });
    await jest.advanceTimersByTimeAsync(30_000);
    expect(config.ticket).toBe('recovered-ticket');
    expect(connect).toHaveBeenCalledTimes(1);
    config.onEvent(frame());
    expect(onSnapshot).toHaveBeenCalledWith(snapshot);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(getTicket).toHaveBeenCalledTimes(9);
    dispose();
  });

  it('cancels scheduled ticket retries when disposed', async () => {
    getTicket.mockRejectedValue(new Error('Temporarily unavailable'));
    const dispose = subscribe();
    await Promise.resolve();
    await Promise.resolve();
    dispose();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(getTicket).toHaveBeenCalledTimes(1);
    expect(onDisconnected).toHaveBeenCalledTimes(1);
    expect(createManager).not.toHaveBeenCalled();
  });

  it('does not schedule another retry when an in-flight ticket fails after disposal', async () => {
    const ticket = Promise.withResolvers<{ ticket: string; expiresAt: number }>();
    getTicket.mockReturnValue(ticket.promise);
    const dispose = subscribe();
    dispose();
    ticket.reject(new Error('Temporarily unavailable'));
    await jest.advanceTimersByTimeAsync(60_000);
    expect(getTicket).toHaveBeenCalledTimes(1);
    expect(onDisconnected).not.toHaveBeenCalled();
    expect(createManager).not.toHaveBeenCalled();
  });
});
