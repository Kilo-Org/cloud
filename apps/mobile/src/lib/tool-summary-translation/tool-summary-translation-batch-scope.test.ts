import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as authEpochModule from '@/lib/auth/auth-epoch';

import './tool-summary-translation-client';
import type * as runtimeModule from './tool-summary-translation-runtime';

/**
 * The runtime and the real gateway client together: the runtime takes a batch,
 * the client resolves the account and sends. Only the credential store, the
 * encrypted-KV cache and `fetch` are faked, so the assertions observe what the
 * device would actually put on the wire.
 *
 * Time is faked. Every step after the batch window is a promise chain, so
 * advancing the clock drains it; nothing is left to run later except the
 * request's own deadline, which never fires in these tests.
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
 * and the epoch the same instance's scope reads.
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
  await vi.advanceTimersByTimeAsync(50);
  expect(getAuthTokenForRequest).toHaveBeenCalledTimes(1);
}

/** Drains the client's promise chain after the batch's last await answers. */
async function settleBatch(): Promise<void> {
  await vi.dynamicImportSettled();
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
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

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('tool summary translation batch scope', () => {
  it('translates a batch while the account and configuration stay current', async () => {
    const { mod } = await loadRuntime();
    getAuthTokenForRequest.mockResolvedValue('token-of-the-account');
    mod.setConfig({ enabled: true, model: MODEL });

    mod.ensureTranslation({ itemId: 'part-1', text: SUMMARY, language: 'de', model: MODEL });
    await dispatchBatch();
    await settleBatch();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const headers = fetchMock.mock.calls[0]?.[1].headers as Record<string, string>;
    expect(headers.Authorization).toContain('token-of-the-account');
    expect(headers['X-KiloCode-OrganizationId']).toBe('org-1');
    expect(mod.getTranslation('part-1', SUMMARY, 'de', MODEL.id)).toBe('Prüfung ausgeführt');
  });

  it('sends nothing when the account epoch moves during the credential read', async () => {
    const { mod, epoch } = await loadRuntime();
    const token = Promise.withResolvers<string | null>();
    getAuthTokenForRequest.mockReturnValue(token.promise);
    mod.setConfig({ enabled: true, model: MODEL });

    mod.ensureTranslation({ itemId: 'part-1', text: SUMMARY, language: 'de', model: MODEL });
    await dispatchBatch();
    // The epoch moves while the client is inside its credential read.
    epoch.bumpAuthEpoch();
    token.resolve('token-of-the-next-account');
    await settleBatch();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mod.getTranslation('part-1', SUMMARY, 'de', MODEL.id)).toBeUndefined();
  });

  it('drops work queued under an earlier account epoch', async () => {
    const { mod, epoch } = await loadRuntime();
    getAuthTokenForRequest.mockResolvedValue('token-of-the-next-account');
    mod.setConfig({ enabled: true, model: MODEL });

    mod.ensureTranslation({ itemId: 'part-1', text: SUMMARY, language: 'de', model: MODEL });
    // The epoch moves before the batch window closes, so the queued work is
    // dropped when a batch would be taken.
    epoch.bumpAuthEpoch();
    await vi.advanceTimersByTimeAsync(50);
    await settleBatch();

    expect(getAuthTokenForRequest).not.toHaveBeenCalled();
    expect(mod.getQueueSize()).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends nothing when the memory reset lands during the credential read', async () => {
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

  it('sends nothing when the opt-in changes during the credential read', async () => {
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
