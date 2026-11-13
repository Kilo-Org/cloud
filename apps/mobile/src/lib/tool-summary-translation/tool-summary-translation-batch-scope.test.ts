import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as authEpochModule from '@/lib/auth/auth-epoch';

import type * as runtimeModule from './tool-summary-translation-runtime';

/**
 * The runtime and the real gateway client together: the runtime takes a batch,
 * the client resolves the account and sends. Only the credential store, the
 * encrypted-KV cache and `fetch` are faked, so the assertions observe what the
 * device would actually put on the wire.
 */

const { getAuthTokenForRequest, getItemAsync, readMock, writeMock } = vi.hoisted(() => ({
  getAuthTokenForRequest: vi.fn(),
  getItemAsync: vi.fn(),
  readMock: vi.fn(),
  writeMock: vi.fn(),
}));

vi.mock('@/lib/config', () => ({ API_BASE_URL: 'https://api.example.com' }));
vi.mock('@/lib/auth/token-owner', () => ({ getAuthTokenForRequest }));
vi.mock('expo-secure-store', () => ({ getItemAsync }));
vi.mock('@/lib/persist/tool-summary-translation-cache', () => ({
  readToolSummaryTranslations: readMock,
  writeToolSummaryTranslation: writeMock,
}));

const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();

const MODEL = { id: 'kilo-auto/small', name: 'Auto Small' };
const SUMMARY = 'ran pnpm test in /srv/private-project';

/** A gateway reply whose single message content is `content`. */
function contentResponse(content: string): Response {
  return Response.json({ choices: [{ message: { content } }] });
}

/**
 * Loads a fresh runtime together with the auth-epoch instance that runtime
 * uses. The imports must stay dynamic: `resetModules` makes the next import
 * re-evaluate a module, which is how this test gets its own runtime instance
 * and the epoch the same instance's fence reads.
 */
async function loadRuntime(): Promise<{
  mod: typeof runtimeModule;
  epoch: typeof authEpochModule;
}> {
  vi.resetModules();
  const mod = await import('./tool-summary-translation-runtime');
  const epoch = await import('@/lib/auth/auth-epoch');
  return { mod, epoch };
}

/** The batch window closed and the client is inside its credential read. */
async function dispatchBatch(): Promise<void> {
  await vi.waitFor(() => {
    expect(getAuthTokenForRequest).toHaveBeenCalledTimes(1);
  });
}

/**
 * Gives the client's remaining promise chain time to finish. The client's work
 * after the credential read is a real promise chain across the lazy module
 * boundary, so a fixed bound is the only way to observe its absence of a
 * request; the broken version calls `fetch` within this window, and the batch
 * window plus import is already 40 ms.
 */
async function settleBatch(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<undefined>();
  setTimeout(() => {
    resolve(undefined);
  }, 200);
  await promise;
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  getAuthTokenForRequest.mockReset();
  getItemAsync.mockReset();
  readMock.mockReset();
  writeMock.mockReset();
  readMock.mockResolvedValue([]);
  writeMock.mockResolvedValue(undefined);
  getItemAsync.mockResolvedValue('org-1');
  fetchMock.mockResolvedValue(contentResponse('["Prüfung ausgeführt"]'));
});

describe('tool summary translation batch scope', () => {
  it('translates a batch while the account and configuration stay current', async () => {
    const { mod } = await loadRuntime();
    getAuthTokenForRequest.mockResolvedValue('token-of-the-account');
    mod.setConfig({ enabled: true, model: MODEL });

    mod.ensureTranslation({ itemId: 'part-1', text: SUMMARY, language: 'de', model: MODEL });
    await settleBatch();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const headers = fetchMock.mock.calls[0]?.[1].headers as Record<string, string>;
    expect(headers.Authorization).toContain('token-of-the-account');
    expect(headers['X-KiloCode-OrganizationId']).toBe('org-1');
    expect(mod.getTranslation('part-1', SUMMARY, 'de', MODEL.id)).toBe('Prüfung ausgeführt');
  });

  it('sends nothing when the account switches while the client resolves it', async () => {
    const { mod, epoch } = await loadRuntime();
    const token = Promise.withResolvers<string | null>();
    getAuthTokenForRequest.mockReturnValue(token.promise);
    mod.setConfig({ enabled: true, model: MODEL });

    mod.ensureTranslation({ itemId: 'part-1', text: SUMMARY, language: 'de', model: MODEL });
    await dispatchBatch();
    // The sign-out of this account and the sign-in of the next one land while
    // the client is inside its credential read.
    epoch.bumpAuthEpoch();
    token.resolve('token-of-the-next-account');
    await settleBatch();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mod.getTranslation('part-1', SUMMARY, 'de', MODEL.id)).toBeUndefined();
  });

  it('sends nothing when the account reset lands while the client resolves it', async () => {
    const { mod } = await loadRuntime();
    const token = Promise.withResolvers<string | null>();
    getAuthTokenForRequest.mockReturnValue(token.promise);
    mod.setConfig({ enabled: true, model: MODEL });

    mod.ensureTranslation({ itemId: 'part-1', text: SUMMARY, language: 'de', model: MODEL });
    await dispatchBatch();
    mod.clearToolSummaryTranslationMemory();
    token.resolve('token-of-the-next-account');
    await settleBatch();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends nothing when the opt-in is turned off while the client resolves it', async () => {
    const { mod } = await loadRuntime();
    const token = Promise.withResolvers<string | null>();
    getAuthTokenForRequest.mockReturnValue(token.promise);
    mod.setConfig({ enabled: true, model: MODEL });

    mod.ensureTranslation({ itemId: 'part-1', text: SUMMARY, language: 'de', model: MODEL });
    await dispatchBatch();
    mod.setConfig({ enabled: false, model: MODEL });
    token.resolve('token-of-the-account');
    await settleBatch();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
