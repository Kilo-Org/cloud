/* eslint-disable require-await, @typescript-eslint/require-await -- injectable query/sleep fakes settle without await */
/* eslint-disable max-lines -- the manager suite pins key rotation, retry cadence, and attachment mints in one file. */
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
vi.mock('expo-crypto', () => {
  let n = 0;
  return {
    randomUUID: () => {
      n += 1;
      return `op-key-${n}`;
    },
  };
});
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
  cacheToolAttachment: vi.fn(),
  cacheToolCardImage: vi.fn(),
}));

const mutate = vi.fn();
const prepareSessionMutate = vi.fn();
vi.mock('@/lib/trpc', () => ({
  trpcClient: {
    cloudAgentNext: {
      getAttachmentDownloadUrl: { mutate },
      prepareSession: { mutate: prepareSessionMutate },
    },
    organizations: {
      cloudAgentNext: { prepareSession: { mutate: prepareSessionMutate } },
    },
  },
}));

const { buildRemoteAttachmentParts } =
  await import('@/components/agents/mobile-session-manager-helpers');
const {
  createMobileAgentSessionManager,
  fetchSessionWithNotFoundRetry,
  isCloudPrepareRetryableError,
  readFetchSessionErrorCode,
} = await import('@/components/agents/mobile-session-manager');
const { createSessionManager: createSessionManagerReal } =
  await import('@kilocode/cloud-agent-sdk');
// The module is mocked with `createSessionManager: vi.fn()` above; recover
// the mock instance typing so `.mockClear()` / `.mock.calls` typecheck.
const createSessionManagerMock = vi.mocked(createSessionManagerReal);

const SESSION_ID = 'ses_test_session_id_0000000001' as KiloSessionId;

function notFoundError(): Error {
  const error = new Error('Session not found') as Error & { data: { code: string } };
  error.data = { code: 'NOT_FOUND' };
  return error;
}

function withCode(code: string, message: string): Error {
  return Object.assign(new Error(message), { data: { code } });
}

function creationInProgressError(): Error {
  return Object.assign(new Error('creation_in_progress'), { data: { code: 'CONFLICT' } });
}

function badRequestError(): Error {
  return Object.assign(new Error('session_creation_failed'), { data: { code: 'BAD_REQUEST' } });
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
        filename: 'archive.zip',
        url: 'https://r2.example.com/signed',
      },
      {
        type: 'file',
        mime: 'text/plain',
        filename: 'notes.txt',
        url: 'https://r2.example.com/signed',
      },
      {
        type: 'file',
        mime: 'image/png',
        filename: 'image.png',
        url: 'https://r2.example.com/signed',
      },
    ]);
  });

  it('sanitizes an unsafe original name before it reaches the wire payload', async () => {
    mutate.mockResolvedValue({
      signedUrl: 'https://r2.example.com/signed',
      key: 'user-id/cloud-agent/msg-uuid/file',
      expiresAt: new Date().toISOString(),
    });

    const submission: AgentAttachmentSubmissionPayload = {
      messageUuid: 'msg-uuid',
      wire: {
        path: 'upload-path',
        files: ['msg-uuid.bin'],
      },
      files: [{ remoteName: 'msg-uuid.bin', originalName: '../../etc/passwd', size: 100 }],
    };

    const parts = await buildRemoteAttachmentParts(submission);
    expect(parts).toHaveLength(1);
    // Basename extraction strips the directory prefix; the isolated
    // basename has no separators and is safe.
    expect(parts[0]?.filename).toBe('passwd');
    // URL and MIME still derived from remoteName
    expect(parts[0]?.url).toBe('https://r2.example.com/signed');
    expect(parts[0]?.mime).toBe('application/octet-stream');
  });

  it('maps bare traversal dot tokens to the wire-safe fallback', async () => {
    mutate.mockResolvedValue({
      signedUrl: 'https://r2.example.com/signed',
      key: 'user-id/cloud-agent/msg-uuid/file',
      expiresAt: new Date().toISOString(),
    });

    const submission: AgentAttachmentSubmissionPayload = {
      messageUuid: 'msg-uuid',
      wire: {
        path: 'upload-path',
        files: ['msg-uuid.bin', 'msg-uuid.bin', 'msg-uuid.bin'],
      },
      files: [
        { remoteName: 'msg-uuid.bin', originalName: '.', size: 100 },
        { remoteName: 'msg-uuid.bin', originalName: '..', size: 100 },
        { remoteName: 'msg-uuid.bin', originalName: 'a/..', size: 100 },
      ],
    };

    const parts = await buildRemoteAttachmentParts(submission);
    expect(parts).toHaveLength(3);
    expect(parts[0]?.filename).toBe('file.bin');
    expect(parts[1]?.filename).toBe('file.bin');
    expect(parts[2]?.filename).toBe('file.bin');
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

describe('isCloudPrepareRetryableError', () => {
  it('keeps the key for creation_in_progress (CONFLICT)', () => {
    expect(isCloudPrepareRetryableError(withCode('CONFLICT', 'creation_in_progress'))).toBe(true);
  });

  it('keeps the key for a network error with no tRPC code', () => {
    expect(isCloudPrepareRetryableError(new Error('Network request failed'))).toBe(true);
  });

  it('keeps the key for transient 5xx-class and rate-limit codes', () => {
    for (const code of [
      'INTERNAL_SERVER_ERROR',
      'BAD_GATEWAY',
      'SERVICE_UNAVAILABLE',
      'GATEWAY_TIMEOUT',
      'TIMEOUT',
      'TOO_MANY_REQUESTS',
    ]) {
      expect(isCloudPrepareRetryableError(withCode(code, 'boom'))).toBe(true);
    }
  });

  it('rotates the key on typed terminal rejections', () => {
    for (const code of [
      'BAD_REQUEST',
      'UNAUTHORIZED',
      'FORBIDDEN',
      'NOT_FOUND',
      'PAYMENT_REQUIRED',
      'PRECONDITION_FAILED',
    ]) {
      expect(isCloudPrepareRetryableError(withCode(code, 'nope'))).toBe(false);
    }
  });

  it('rotates the key on a CONFLICT with any other message', () => {
    expect(isCloudPrepareRetryableError(withCode('CONFLICT', 'something else'))).toBe(false);
  });
});

describe('createMobileAgentSessionManager prepare operationKey', () => {
  const PREPARE_INPUT = {
    prompt: 'continue this',
    mode: 'code',
    model: 'kilo-auto/efficient',
    githubRepo: 'owner/repo',
    initialMessageId: 'msg-1',
  };

  function createPrepare(): {
    prepare: (input: Record<string, unknown>) => Promise<{
      cloudAgentSessionId: string;
      kiloSessionId: string;
    }>;
  } {
    createSessionManagerMock.mockClear();
    createMobileAgentSessionManager({
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- store is never read with the SDK mocked
      store: {} as never,
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- connection is never read with the SDK mocked
      userWebConnection: {} as never,
      organizationId: undefined,
    });
    const config = createSessionManagerMock.mock.calls[0]?.[0];
    if (!config) {
      throw new Error('createSessionManager was not called');
    }
    return config as unknown as {
      prepare: (input: Record<string, unknown>) => Promise<{
        cloudAgentSessionId: string;
        kiloSessionId: string;
      }>;
    };
  }

  beforeEach(() => {
    prepareSessionMutate.mockReset();
  });

  it('attaches a stable operationKey when autoInitiate is true and keeps it across retryable failures', async () => {
    prepareSessionMutate
      .mockRejectedValueOnce(creationInProgressError())
      .mockRejectedValueOnce(creationInProgressError())
      .mockResolvedValue({ cloudAgentSessionId: 'c-1', kiloSessionId: 'k-1' });
    const config = createPrepare();
    const input = { ...PREPARE_INPUT, autoInitiate: true };

    await expect(config.prepare(input)).rejects.toBeDefined();
    await expect(config.prepare(input)).rejects.toBeDefined();
    await config.prepare(input);

    const keys = prepareSessionMutate.mock.calls.map(
      call => (call[0] as { operationKey?: string }).operationKey
    );
    expect(keys).toEqual([expect.any(String), keys[0], keys[0]]);
    expect(prepareSessionMutate.mock.calls[0]?.[0]).toMatchObject({
      autoInitiate: true,
      operationKey: expect.any(String),
    });
  });

  it('rotates the operationKey after a successful prepare', async () => {
    prepareSessionMutate
      .mockRejectedValueOnce(creationInProgressError())
      .mockResolvedValue({ cloudAgentSessionId: 'c-1', kiloSessionId: 'k-1' });
    const config = createPrepare();
    const input = { ...PREPARE_INPUT, autoInitiate: true };

    await expect(config.prepare(input)).rejects.toBeDefined();
    await config.prepare(input);
    await config.prepare(input);

    const keys = prepareSessionMutate.mock.calls.map(
      call => (call[0] as { operationKey?: string }).operationKey
    );
    expect(keys[0]).toBeDefined();
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it('rotates the operationKey after a typed non-retryable rejection', async () => {
    prepareSessionMutate
      .mockRejectedValueOnce(badRequestError())
      .mockResolvedValue({ cloudAgentSessionId: 'c-1', kiloSessionId: 'k-1' });
    const config = createPrepare();
    const input = { ...PREPARE_INPUT, autoInitiate: true };

    await expect(config.prepare(input)).rejects.toBeDefined();
    await config.prepare(input);

    const keys = prepareSessionMutate.mock.calls.map(
      call => (call[0] as { operationKey?: string }).operationKey
    );
    expect(keys[1]).not.toBe(keys[0]);
  });

  it('never attaches an operationKey when autoInitiate is absent', async () => {
    prepareSessionMutate.mockResolvedValue({ cloudAgentSessionId: 'c-1', kiloSessionId: 'k-1' });
    const config = createPrepare();

    await config.prepare(PREPARE_INPUT);

    expect(prepareSessionMutate.mock.calls[0]?.[0]).not.toHaveProperty('operationKey');
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
