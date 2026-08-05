import { afterEach, describe, expect, it, vi } from 'vitest';

const httpLinkMock = vi.hoisted(() => vi.fn());
const httpBatchLinkMock = vi.hoisted(() => vi.fn());
const createTRPCClientMock = vi.hoisted(() => vi.fn());
const splitLinkMock = vi.hoisted(() =>
  vi.fn((opts: { condition: unknown; true: unknown; false: unknown }) => [opts.true, opts.false])
);

vi.mock('@trpc/client', () => ({
  createTRPCClient: createTRPCClientMock,
  httpLink: httpLinkMock,
  httpBatchLink: httpBatchLinkMock,
  splitLink: splitLinkMock,
}));

vi.mock('@trpc/tanstack-react-query', () => ({
  createTRPCContext: vi.fn(() => ({
    TRPCProvider: { $$typeof: Symbol.for('react.provider') },
    useTRPC: vi.fn(),
  })),
}));

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async () => {
    await Promise.resolve();
    return null;
  }),
}));

vi.mock('@/lib/config', () => ({
  API_BASE_URL: 'https://api.example.com',
  E2E_LATENCY_MESSAGES_MS: 0,
  E2E_LATENCY_SESSION_MS: 0,
}));

vi.mock('@/lib/storage-keys', () => ({
  AUTH_TOKEN_KEY: 'auth-token',
  TOKEN_EXPIRES_AT_KEY: 'token-expires-at',
}));

// auth-context pulls in react-native, Sentry and the telemetry modules.
// This test only inspects link options, so stub the two symbols trpc.ts uses.
vi.mock('@/lib/auth/auth-context', () => ({
  performRefresh: vi.fn().mockResolvedValue({ ok: false, refused: false }),
  REFRESH_MARGIN_MS: 60_000,
}));

afterEach(() => {
  vi.resetModules();
  httpLinkMock.mockClear();
  httpBatchLinkMock.mockClear();
  createTRPCClientMock.mockClear();
});

describe('tRPC client link options', () => {
  it('passes methodOverride: "POST" to httpLink', async () => {
    httpLinkMock.mockReturnValue({});
    httpBatchLinkMock.mockReturnValue({});
    createTRPCClientMock.mockReturnValue({});

    await import('./trpc');

    expect(httpLinkMock).toHaveBeenCalledTimes(1);
    const httpLinkOpts = httpLinkMock.mock.calls[0]?.[0];
    expect(httpLinkOpts).toHaveProperty('methodOverride', 'POST');
  });

  it('passes methodOverride: "POST" to httpBatchLink', async () => {
    httpLinkMock.mockReturnValue({});
    httpBatchLinkMock.mockReturnValue({});
    createTRPCClientMock.mockReturnValue({});

    await import('./trpc');

    expect(httpBatchLinkMock).toHaveBeenCalledTimes(1);
    const httpBatchLinkOpts = httpBatchLinkMock.mock.calls[0]?.[0];
    expect(httpBatchLinkOpts).toHaveProperty('methodOverride', 'POST');
  });
});
