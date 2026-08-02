/* eslint-disable require-await, @typescript-eslint/require-await -- injectable query/sleep fakes settle without await */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type AgentAttachmentSubmissionPayload } from '@/lib/agent-attachments/agent-attachment-types';
import { SPAWNED_NOT_FOUND_MAX_ATTEMPTS } from '@/lib/spawned-not-found-retry';
import { type KiloSessionId } from '@kilocode/cloud-agent-sdk';

// Keep this suite on the pure vitest project: mock every RN / Expo / SDK
// side-effect import that `mobile-session-manager.ts` pulls transitively
// before loading the module under test.
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(),
}));
vi.mock('sonner-native', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock('@kilocode/cloud-agent-sdk', () => ({
  createSessionManager: vi.fn(),
}));
vi.mock('@/components/agents/mobile-session-transport-payload', () => ({
  normalizeTransportPayload: vi.fn((x: unknown) => x),
}));
vi.mock('@/components/agents/mobile-session-diagnostics', () => ({
  formatSafeCloudAgentFailureDiagnostic: vi.fn(),
  withCloudAgentDiagnostics: vi.fn((_op: string, _org: unknown, fn: () => unknown) => fn()),
}));
vi.mock('@/components/agents/mobile-session-page-adapter', () => ({
  fetchMobileSessionSnapshotPage: vi.fn(),
}));
vi.mock('@/lib/config', () => ({
  API_BASE_URL: 'https://api.test',
  CLOUD_AGENT_WS_URL: 'wss://ws.test',
  WEB_BASE_URL: 'https://web.test',
}));
vi.mock('@/lib/user-web-connection-lifecycle', () => ({
  createNativeUserWebConnectionLifecycleHooks: vi.fn(() => ({})),
}));
vi.mock('@/components/agents/tool-card-image-cache', () => ({
  cacheToolCardImage: vi.fn(),
}));

const mutate = vi.fn();
vi.mock('@/lib/trpc', () => ({
  trpcClient: {
    cloudAgentNext: {
      getAttachmentDownloadUrl: { mutate },
    },
  },
}));

const { buildRemoteAttachmentParts } =
  await import('@/components/agents/mobile-session-manager-helpers');
const { fetchSessionWithNotFoundRetry, readFetchSessionErrorCode } =
  await import('@/components/agents/mobile-session-manager');

const SESSION_ID = 'ses_test_session_id_0000000001' as KiloSessionId;

function notFoundError(): Error {
  const error = new Error('Session not found') as Error & { data: { code: string } };
  error.data = { code: 'NOT_FOUND' };
  return error;
}

describe('buildRemoteAttachmentParts', () => {
  beforeEach(() => {
    mutate.mockReset();
  });

  it('mints each download URL from the upload path and remoteName', async () => {
    mutate.mockResolvedValue({
      signedUrl: 'https://r2.example.com/signed',
      key: 'user-id/cloud-agent/msg-uuid/file',
      expiresAt: new Date().toISOString(),
    });

    const submission: AgentAttachmentSubmissionPayload = {
      messageUuid: 'msg-uuid',
      wire: {
        path: 'upload-path',
        files: ['msg-uuid.zip', 'msg-uuid.txt', 'msg-uuid.png'],
      },
      files: [
        { remoteName: 'msg-uuid.zip', originalName: 'archive.zip', size: 100 },
        { remoteName: 'msg-uuid.txt', originalName: 'notes.txt', size: 50 },
        { remoteName: 'msg-uuid.png', originalName: 'image.png', size: 200 },
      ],
    };

    const parts = await buildRemoteAttachmentParts(submission);

    expect(mutate).toHaveBeenCalledTimes(3);
    expect(mutate).toHaveBeenCalledWith({ messageUuid: 'upload-path', filename: 'msg-uuid.zip' });
    expect(mutate).toHaveBeenCalledWith({ messageUuid: 'upload-path', filename: 'msg-uuid.txt' });
    expect(mutate).toHaveBeenCalledWith({ messageUuid: 'upload-path', filename: 'msg-uuid.png' });

    expect(parts).toEqual([
      {
        type: 'file',
        mime: 'application/octet-stream',
        filename: 'msg-uuid.zip',
        url: 'https://r2.example.com/signed',
      },
      {
        type: 'file',
        mime: 'text/plain',
        filename: 'msg-uuid.txt',
        url: 'https://r2.example.com/signed',
      },
      {
        type: 'file',
        mime: 'image/png',
        filename: 'msg-uuid.png',
        url: 'https://r2.example.com/signed',
      },
    ]);
  });
});

describe('readFetchSessionErrorCode', () => {
  it('reads data.code', () => {
    expect(readFetchSessionErrorCode({ data: { code: 'NOT_FOUND' } })).toBe('NOT_FOUND');
  });

  it('reads shape.data.code', () => {
    expect(readFetchSessionErrorCode({ shape: { data: { code: 'FORBIDDEN' } } })).toBe('FORBIDDEN');
  });

  it('reads top-level code', () => {
    expect(readFetchSessionErrorCode({ code: 'TIMEOUT' })).toBe('TIMEOUT');
  });

  it('returns undefined for non-objects', () => {
    expect(readFetchSessionErrorCode(null)).toBeUndefined();
    expect(readFetchSessionErrorCode('nope')).toBeUndefined();
  });
});

describe('fetchSessionWithNotFoundRetry', () => {
  // Production return type is SessionWithRuntimeState; tests inject a minimal
  // stand-in via `query` and only assert retry/cadence behavior.
  type QueryFn = NonNullable<Parameters<typeof fetchSessionWithNotFoundRetry>[1]>['query'];
  const ok = { ok: true } as unknown as Awaited<ReturnType<NonNullable<QueryFn>>>;

  it('returns on the first successful query without sleeping', async () => {
    const queryMock = vi.fn(async () => ok);
    const sleep = vi.fn(async () => undefined);
    await expect(
      fetchSessionWithNotFoundRetry(SESSION_ID, {
        query: queryMock as unknown as QueryFn,
        sleep,
      })
    ).resolves.toBe(ok);
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries NOT_FOUND up to the spawned budget then succeeds', async () => {
    const queryMock = vi
      .fn()
      .mockRejectedValueOnce(notFoundError())
      .mockRejectedValueOnce(notFoundError())
      .mockResolvedValueOnce(ok);
    const sleep = vi.fn(async () => undefined);

    await expect(
      fetchSessionWithNotFoundRetry(SESSION_ID, {
        query: queryMock as unknown as QueryFn,
        sleep,
      })
    ).resolves.toBe(ok);

    expect(queryMock).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it('exhausts SPAWNED_NOT_FOUND_MAX_ATTEMPTS retries then throws', async () => {
    const queryMock = vi.fn(async () => {
      throw notFoundError();
    });
    const sleep = vi.fn(async () => undefined);

    await expect(
      fetchSessionWithNotFoundRetry(SESSION_ID, {
        query: queryMock as unknown as QueryFn,
        sleep,
      })
    ).rejects.toMatchObject({ data: { code: 'NOT_FOUND' } });

    // 1 initial + SPAWNED_NOT_FOUND_MAX_ATTEMPTS retries
    expect(queryMock).toHaveBeenCalledTimes(SPAWNED_NOT_FOUND_MAX_ATTEMPTS + 1);
    expect(sleep).toHaveBeenCalledTimes(SPAWNED_NOT_FOUND_MAX_ATTEMPTS);
  });

  it('fails immediately on a non-NOT_FOUND error', async () => {
    const error = Object.assign(new Error('boom'), { data: { code: 'INTERNAL_SERVER_ERROR' } });
    const queryMock = vi.fn(async () => {
      throw error;
    });
    const sleep = vi.fn(async () => undefined);

    await expect(
      fetchSessionWithNotFoundRetry(SESSION_ID, {
        query: queryMock as unknown as QueryFn,
        sleep,
      })
    ).rejects.toBe(error);
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('fails immediately when the error has no tRPC code', async () => {
    const error = new Error('network');
    const queryMock = vi.fn(async () => {
      throw error;
    });
    const sleep = vi.fn(async () => undefined);

    await expect(
      fetchSessionWithNotFoundRetry(SESSION_ID, {
        query: queryMock as unknown as QueryFn,
        sleep,
      })
    ).rejects.toBe(error);
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
