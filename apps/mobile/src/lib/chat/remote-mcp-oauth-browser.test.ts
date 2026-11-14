import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Android sign-in return, where the redirect arrives as a deep link.
 *
 * What is worth proving is which sign-in a completion belongs to: two rows can
 * both offer Sign in, and the redirect that comes back names its authorization
 * by `state`. Handing it to whatever is waiting completes the wrong sign-in, and
 * `authorizationCodeOf` then rejects it on the same check, so the person's
 * finished authorization reports a failure.
 */

const world = vi.hoisted(() => ({
  listeners: new Set<(state: string) => void>(),
  opened: [] as string[],
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  AppState: {
    addEventListener: (_event: string, listener: (state: string) => void) => {
      world.listeners.add(listener);
      return {
        remove: () => {
          world.listeners.delete(listener);
        },
      };
    },
  },
}));

vi.mock('expo-web-browser', () => ({
  openBrowserAsync: (url: string) => {
    world.opened.push(url);
    return Promise.resolve({ type: 'dismiss' });
  },
  openAuthSessionAsync: () => Promise.resolve({ type: 'dismiss' }),
}));

vi.mock('./remote-mcp-oauth-provider', () => ({
  REMOTE_MCP_REDIRECT_URL: 'kiloapp:///remote-mcp',
}));

const { openRemoteMcpAuthorization, takeRemoteMcpRedirect } =
  await import('./remote-mcp-oauth-browser');

const authorizeA = 'https://auth.example/authorize?client_id=one&state=a';
const authorizeB = 'https://auth.example/authorize?client_id=two&state=b';
const redirectA = 'kiloapp:///remote-mcp?code=ca&state=a';
const redirectB = 'kiloapp:///remote-mcp?code=cb&state=b';

/** Whether a promise has not settled yet, after the microtasks it would settle in. */
async function isPending(settled: Promise<unknown>): Promise<boolean> {
  const raced = await Promise.race([
    settled.then(() => 'settled' as const),
    Promise.resolve('pending' as const),
  ]);
  return raced === 'pending';
}

beforeEach(() => {
  world.listeners.clear();
  world.opened.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('an Android sign-in return', () => {
  it('reaches the sign-in that started it even after a second sign-in opened', async () => {
    const a = openRemoteMcpAuthorization(authorizeA);
    const b = openRemoteMcpAuthorization(authorizeB);

    expect(takeRemoteMcpRedirect(redirectA)).toBe(true);
    await expect(a).resolves.toBe(redirectA);
    expect(await isPending(b)).toBe(true);

    takeRemoteMcpRedirect(redirectB);
    await expect(b).resolves.toBe(redirectB);
  });

  it('drops a completion whose sign-in already turned back, leaving the next one waiting', async () => {
    vi.useFakeTimers();
    const a = openRemoteMcpAuthorization(authorizeA);
    /* The person left the browser: the app comes back and A's grace window runs
       out, which is how a turned-back sign-in ends. */
    for (const listener of world.listeners) {
      listener('active');
    }
    await vi.advanceTimersByTimeAsync(1500);
    await expect(a).resolves.toBeNull();

    const b = openRemoteMcpAuthorization(authorizeB);
    takeRemoteMcpRedirect(redirectA);
    expect(await isPending(b)).toBe(true);

    takeRemoteMcpRedirect(redirectB);
    await expect(b).resolves.toBe(redirectB);
  });

  it('opens no browser for an authorization it cannot correlate, and reports a failure', async () => {
    await expect(
      openRemoteMcpAuthorization('https://auth.example/authorize?client_id=one')
    ).rejects.toThrow(/no state/);

    expect(world.opened).toEqual([]);
  });

  it('answers false for a deep link that is not the redirect', () => {
    expect(takeRemoteMcpRedirect('kiloapp:///something-else?code=ca&state=a')).toBe(false);
  });
});
