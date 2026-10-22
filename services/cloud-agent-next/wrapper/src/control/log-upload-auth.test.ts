import { describe, expect, it } from 'bun:test';
import type { ControlPlaneWrapperFrame } from '../../../src/shared/control-plane-protocol.js';
import { CONTROL_LOG_REFRESH_WINDOW_MS, createControlLogUploadAuth } from './log-upload-auth.js';

const HOUR_MS = 60 * 60 * 1000;

function tokenWithExpiry(expiresAt: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(expiresAt / 1000) })).toString(
    'base64url'
  );
  return `header.${payload}.signature`;
}

function setup(options: { initialGrant?: string; clock?: number } = {}) {
  let clock = options.clock ?? 0;
  const frames: ControlPlaneWrapperFrame[] = [];
  const auth = createControlLogUploadAuth({
    initialGrant: options.initialGrant,
    send: frame => frames.push(frame),
    now: () => clock,
    responseTimeoutMs: 1,
    retryDelaysMs: [0, 0],
  });
  return {
    auth,
    frames,
    now: () => clock,
    setNow: (value: number) => {
      clock = value;
    },
  };
}

describe('control log upload auth', () => {
  it('renews when exactly the last hour remains at fake 4h, 8h and 12h', async () => {
    const { auth, frames, setNow } = setup({ initialGrant: tokenWithExpiry(4 * HOUR_MS) });
    auth.connected();
    auth.receive({
      type: 'logs.credentials',
      grant: tokenWithExpiry(4 * HOUR_MS),
      expiresAt: 4 * HOUR_MS,
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    for (const hour of [4, 8, 12]) {
      setNow(hour * HOUR_MS - CONTROL_LOG_REFRESH_WINDOW_MS - 1);
      const before = frames.length;
      auth.tick();
      expect(frames).toHaveLength(before);

      setNow(hour * HOUR_MS - CONTROL_LOG_REFRESH_WINDOW_MS);
      auth.tick();
      expect(frames).toHaveLength(before + 1);
      const nextExpiry = (hour + 4) * HOUR_MS;
      auth.receive({
        type: 'logs.credentials',
        grant: tokenWithExpiry(nextExpiry),
        expiresAt: nextExpiry,
      });
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(auth.current()?.expiresAt).toBe(nextExpiry);
    }
  });

  it('stops sending while disconnected', async () => {
    const { auth, frames } = setup({ initialGrant: tokenWithExpiry(4 * HOUR_MS) });
    auth.tick();
    expect(frames).toHaveLength(0);
    expect(await auth.rejected(tokenWithExpiry(4 * HOUR_MS))).toBe(false);
    expect(frames).toHaveLength(0);
  });

  it('retries a missing credential a bounded number of times', async () => {
    const grant = tokenWithExpiry(4 * HOUR_MS);
    const { auth, frames } = setup({ initialGrant: grant });
    auth.connected();
    // Wait out the connection-time request, then measure the rejection retry.
    expect(await auth.rejected(grant)).toBe(false);
    frames.length = 0;
    const refreshed = await auth.rejected(grant);
    expect(refreshed).toBe(false);
    expect(frames).toHaveLength(3);
    expect(frames.every(frame => frame.type === 'logs.refresh')).toBe(true);
  });

  it('ignores a late rejection for a token that was already replaced', async () => {
    const oldToken = tokenWithExpiry(4 * HOUR_MS);
    const newToken = tokenWithExpiry(8 * HOUR_MS);
    const { auth, frames } = setup({ initialGrant: oldToken });
    auth.connected();
    frames.length = 0;
    auth.receive({ type: 'logs.credentials', grant: newToken, expiresAt: 8 * HOUR_MS });

    expect(await auth.rejected(oldToken)).toBe(true);
    expect(frames).toHaveLength(0);
    expect(auth.current()?.token).toBe(newToken);
  });

  it('withholds a rejected current token until it is replaced', async () => {
    const oldToken = tokenWithExpiry(4 * HOUR_MS);
    const newToken = tokenWithExpiry(8 * HOUR_MS);
    const { auth, frames } = setup({ initialGrant: oldToken });
    auth.connected();
    auth.receive({ type: 'logs.credentials', grant: oldToken, expiresAt: 4 * HOUR_MS });
    await new Promise(resolve => setTimeout(resolve, 0));
    frames.length = 0;

    const refreshing = auth.rejected(oldToken);
    expect(frames).toHaveLength(1);
    // The refused bearer is not offered again while its replacement is pending.
    expect(auth.current()).toBeUndefined();
    auth.receive({ type: 'logs.credentials', grant: newToken, expiresAt: 8 * HOUR_MS });
    expect(await refreshing).toBe(true);
    expect(auth.current()?.token).toBe(newToken);
  });

  it('does not withhold a new token after a late rejection of the old one', async () => {
    const oldToken = tokenWithExpiry(4 * HOUR_MS);
    const newToken = tokenWithExpiry(8 * HOUR_MS);
    const { auth, frames } = setup({ initialGrant: oldToken });
    auth.connected();
    auth.receive({ type: 'logs.credentials', grant: newToken, expiresAt: 8 * HOUR_MS });
    await new Promise(resolve => setTimeout(resolve, 0));
    frames.length = 0;

    expect(await auth.rejected(oldToken)).toBe(true);
    expect(frames).toHaveLength(0);
    expect(auth.current()?.token).toBe(newToken);
  });

  it('rotates the current token after its own rejection', async () => {
    const oldToken = tokenWithExpiry(4 * HOUR_MS);
    const newToken = tokenWithExpiry(8 * HOUR_MS);
    const { auth, frames } = setup({ initialGrant: oldToken });
    auth.connected();
    auth.receive({ type: 'logs.credentials', grant: oldToken, expiresAt: 4 * HOUR_MS });
    await new Promise(resolve => setTimeout(resolve, 0));
    frames.length = 0;

    const refreshing = auth.rejected(oldToken);
    expect(frames).toHaveLength(1);
    auth.receive({ type: 'logs.credentials', grant: newToken, expiresAt: 8 * HOUR_MS });
    expect(await refreshing).toBe(true);
    expect(auth.current()?.token).toBe(newToken);
  });

  it('recovers from a restarted process using an expired launch proof', () => {
    const expiredProof = tokenWithExpiry(HOUR_MS);
    const { auth, frames } = setup({ initialGrant: expiredProof, clock: 12 * HOUR_MS });
    expect(auth.current()).toBeUndefined();
    auth.connected();
    expect(frames).toEqual([{ type: 'logs.refresh', grant: expiredProof }]);
    auth.receive({
      type: 'logs.credentials',
      grant: tokenWithExpiry(16 * HOUR_MS),
      expiresAt: 16 * HOUR_MS,
    });
    expect(auth.current()?.expiresAt).toBe(16 * HOUR_MS);
  });
});
