import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../types';
import { FacadeMetadataFeed } from './metadata-feed';

class ClientSocket extends EventTarget {
  accept = vi.fn();
  close = vi.fn();
}

function callbacks() {
  return {
    onMessage: vi.fn(),
    onConnected: vi.fn(),
    onStopped: vi.fn(),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('FacadeMetadataFeed', () => {
  it('cancels reconnect work when final demand ends', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockRejectedValue(new Error('temporarily unavailable'));
    const env = {
      INTERNAL_API_SECRET_PROD: { get: vi.fn().mockResolvedValue('secret') },
      SESSION_INGEST: { fetch },
    } as unknown as Env;
    const feed = new FacadeMetadataFeed(env, callbacks());

    feed.addDemand('usr_1');
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledOnce();

    feed.removeDemand();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('reconnects after an active socket disconnects while demand remains', async () => {
    vi.useFakeTimers();
    const firstSocket = new ClientSocket();
    const secondSocket = new ClientSocket();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ status: 101, webSocket: firstSocket })
      .mockResolvedValueOnce({ status: 101, webSocket: secondSocket });
    const env = {
      INTERNAL_API_SECRET_PROD: { get: vi.fn().mockResolvedValue('secret') },
      SESSION_INGEST: { fetch },
    } as unknown as Env;
    const connected = callbacks();
    const feed = new FacadeMetadataFeed(env, connected);

    feed.addDemand('usr_1');
    await vi.advanceTimersByTimeAsync(0);
    expect(firstSocket.accept).toHaveBeenCalledOnce();
    expect(connected.onConnected).toHaveBeenCalledOnce();

    firstSocket.dispatchEvent(new Event('close'));
    await vi.advanceTimersByTimeAsync(250);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(secondSocket.accept).toHaveBeenCalledOnce();
    expect(connected.onConnected).toHaveBeenCalledTimes(2);
    feed.removeDemand();
  });

  it('keeps backing off when successful sockets close before becoming stable', async () => {
    vi.useFakeTimers();
    const firstSocket = new ClientSocket();
    const secondSocket = new ClientSocket();
    const thirdSocket = new ClientSocket();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ status: 101, webSocket: firstSocket })
      .mockResolvedValueOnce({ status: 101, webSocket: secondSocket })
      .mockResolvedValueOnce({ status: 101, webSocket: thirdSocket });
    const env = {
      INTERNAL_API_SECRET_PROD: { get: vi.fn().mockResolvedValue('secret') },
      SESSION_INGEST: { fetch },
    } as unknown as Env;
    const feed = new FacadeMetadataFeed(env, callbacks());

    feed.addDemand('usr_1');
    await vi.advanceTimersByTimeAsync(0);
    firstSocket.dispatchEvent(new Event('close'));
    await vi.advanceTimersByTimeAsync(250);
    expect(fetch).toHaveBeenCalledTimes(2);

    secondSocket.dispatchEvent(new Event('close'));
    await vi.advanceTimersByTimeAsync(499);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(3);

    feed.removeDemand();
  });

  it('closes a late successful socket after demand has ended', async () => {
    const socket = new ClientSocket();
    let resolveFetch: ((response: { status: number; webSocket: ClientSocket }) => void) | undefined;
    const fetch = vi.fn(
      () =>
        new Promise<{ status: number; webSocket: ClientSocket }>(
          resolve => (resolveFetch = resolve)
        )
    );
    const env = {
      INTERNAL_API_SECRET_PROD: { get: vi.fn().mockResolvedValue('secret') },
      SESSION_INGEST: { fetch },
    } as unknown as Env;
    const connected = callbacks();
    const feed = new FacadeMetadataFeed(env, connected);

    feed.addDemand('usr_1');
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    feed.removeDemand();
    resolveFetch?.({ status: 101, webSocket: socket });
    await Promise.resolve();

    expect(socket.accept).not.toHaveBeenCalled();
    expect(socket.close).toHaveBeenCalledWith(1000, 'Facade metadata demand ended');
    expect(connected.onConnected).not.toHaveBeenCalled();
  });
});
