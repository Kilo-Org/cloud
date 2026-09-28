/* eslint-disable require-await, @typescript-eslint/require-await -- the fake mutate/fetch factories settle without await because they resolve immediately */
/* eslint-disable max-lines -- one mock harness covers the happy path, the retry semantics, the four failure codes and the continue variant */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getAgentSessionPath } from '@/components/agents/session-detail-routes';
import { i18n } from '@/i18n';
import { type OutboxRow } from '@/lib/persist/mutation-outbox';
import { AGENT_MODEL_PREFERENCE_KEY } from '@/lib/storage-keys';
import { startAgent } from './start-agent';

const SESSION_ID = 'ses_12345678901234567890123456';

const prepareSessionMutate = vi.hoisted(() => vi.fn());
const listOutboxRows = vi.hoisted(() => vi.fn());
const writeOutboxRow = vi.hoisted(() => vi.fn());
const removeOutboxRow = vi.hoisted(() => vi.fn());
const recentRepositoriesQuery = vi.hoisted(() => vi.fn());
const getMeQuery = vi.hoisted(() => vi.fn());
const getItemAsync = vi.hoisted(() => vi.fn());
const fetchMock = vi.hoisted(() => vi.fn());
const cryptoMock = vi.hoisted(() => ({ next: 0 }));

vi.mock('@/lib/config', () => ({ API_BASE_URL: 'https://api.example.com' }));

vi.mock('expo-secure-store', () => ({ getItemAsync }));

// One deterministic UUID per intent, so a retained key and a rotated key are
// distinct values the assertions can name without reaching into the module.
vi.mock('expo-crypto', () => ({
  randomUUID: () => {
    cryptoMock.next += 1;
    return `op-key-${cryptoMock.next}`;
  },
}));

vi.mock('@/lib/auth/token-owner', () => ({
  getAuthTokenForRequest: async (): Promise<string> => 'token',
}));

// The outbox is a native SQLCipher chain; the fake below mirrors the two reads
// and the write/remove the headless runtime uses (the real module's semantics
// are covered by its own suite).
vi.mock('@/lib/persist/mutation-outbox', () => ({
  listOutboxRows,
  writeOutboxRow,
  removeOutboxRow,
}));

vi.mock('@/lib/trpc', () => ({
  trpcClient: {
    cloudAgentNext: { prepareSession: { mutate: prepareSessionMutate } },
    organizations: { cloudAgentNext: { prepareSession: { mutate: prepareSessionMutate } } },
    cliSessionsV2: { recentRepositories: { query: recentRepositoriesQuery } },
    user: { getMe: { query: getMeQuery } },
  },
  useTRPC: () => ({}),
}));

// Mirror of the real retryability predicate (covered by its own suite); this
// test only needs one retryable and one terminal shape.
vi.mock('@/components/agents/mobile-session-manager', () => {
  const TRANSIENT_CODES = new Set([
    'INTERNAL_SERVER_ERROR',
    'BAD_GATEWAY',
    'SERVICE_UNAVAILABLE',
    'GATEWAY_TIMEOUT',
    'TIMEOUT',
    'TOO_MANY_REQUESTS',
  ]);
  return {
    isCloudPrepareRetryableError: (error: unknown) => {
      const record = error as { data?: { code?: string }; code?: string; message?: string };
      const code = record.data?.code ?? record.code;
      if (code === undefined) {
        return true;
      }
      if (code === 'CONFLICT') {
        return record.message === 'creation_in_progress';
      }
      return TRANSIENT_CODES.has(code);
    },
  };
});

// One catalogue row the real `toModelOptions` turns into a variant bearing
// option, so the auto-selection picks the same model/variant the form would.
const CATALOG_MODEL = {
  id: 'anthropic/claude',
  name: 'Claude: Sonnet',
  opencode: { variants: { low: {}, high: {} } },
};

function serviceUnavailableError(): Error {
  return Object.assign(new Error('service_unavailable'), {
    data: { code: 'SERVICE_UNAVAILABLE' },
  });
}

function badRequestError(): Error {
  return Object.assign(new Error('session_creation_failed'), { data: { code: 'BAD_REQUEST' } });
}

function usedOperationKeys(): (string | undefined)[] {
  return prepareSessionMutate.mock.calls.map(
    call => (call[0] as { operationKey?: string }).operationKey
  );
}

function writtenRow(index = 0): OutboxRow {
  return writeOutboxRow.mock.calls[index]?.[1] as OutboxRow;
}

beforeEach(() => {
  vi.clearAllMocks();
  cryptoMock.next = 0;
  prepareSessionMutate.mockResolvedValue({ kiloSessionId: SESSION_ID });
  recentRepositoriesQuery.mockResolvedValue({ repositories: [] });
  getMeQuery.mockResolvedValue({ id: 'user-1' });
  getItemAsync.mockResolvedValue(null);
  listOutboxRows.mockResolvedValue([]);
  writeOutboxRow.mockResolvedValue(undefined);
  removeOutboxRow.mockResolvedValue(undefined);
  fetchMock.mockResolvedValue({
    ok: true,
    json: async (): Promise<{ data: (typeof CATALOG_MODEL)[] }> => ({ data: [CATALOG_MODEL] }),
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('__DEV__', false);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('startAgent happy path', () => {
  it('starts a session and returns its id and the agent-chat href', async () => {
    const result = await startAgent({
      prompt: 'fix the failing build',
      repository: 'https://github.com/owner/repo',
    });

    if (!result.ok) {
      throw new Error(`expected a successful start, got ${result.code}`);
    }
    expect(result.action).toBe('StartAgent');
    expect(result.sessionId).toBe(SESSION_ID);
    expect(result.href).toBe(getAgentSessionPath(SESSION_ID));
    expect(result.message).toBe(i18n.t('common.done'));
  });

  it('prepares with the same body the in-app form sends', async () => {
    await startAgent({
      prompt: 'fix the failing build',
      repository: 'https://github.com/owner/repo',
    });

    expect(prepareSessionMutate).toHaveBeenCalledTimes(1);
    expect(prepareSessionMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'fix the failing build',
        mode: 'code',
        model: 'anthropic/claude',
        variant: 'low',
        githubRepo: 'owner/repo',
        autoCommit: false,
        autoInitiate: true,
        operationKey: expect.any(String),
      })
    );
  });

  it('persists the safe-retry row before the mutate and removes it on success', async () => {
    await startAgent({ prompt: 'fix the failing build', repository: 'owner/repo' });

    expect(writeOutboxRow).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        taxonomy: 'safe-retry',
        operationKey: expect.any(String),
        fingerprint: expect.any(String),
      })
    );
    expect(writeOutboxRow.mock.invocationCallOrder[0] ?? 0).toBeLessThan(
      prepareSessionMutate.mock.invocationCallOrder[0] ?? 0
    );
    expect(removeOutboxRow).toHaveBeenCalledTimes(1);
    expect(removeOutboxRow).toHaveBeenCalledWith('user-1', writtenRow().fingerprint);
  });

  it('uses the most recent repository when the request names none', async () => {
    recentRepositoriesQuery.mockResolvedValue({
      repositories: [{ gitUrl: 'git@github.com:owner/recent.git', lastUsedAt: '2026-09-15' }],
    });

    const result = await startAgent({ prompt: 'fix the failing build' });

    expect(result.ok).toBe(true);
    expect(prepareSessionMutate).toHaveBeenCalledWith(
      expect.objectContaining({ githubRepo: 'owner/recent' })
    );
  });

  it('restores the persisted model preference', async () => {
    getItemAsync.mockResolvedValue(
      JSON.stringify({ personal: { model: 'anthropic/claude', variant: 'high' } })
    );

    await startAgent({ prompt: 'fix the failing build', repository: 'owner/repo' });

    expect(prepareSessionMutate).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'anthropic/claude', variant: 'high' })
    );
    // One cross-platform read: the preference key goes through the shared
    // SecureStore entry point, which is what `expo-secure-store` backs on both
    // iOS and Android.
    expect(getItemAsync.mock.calls[0]?.[0]).toBe(AGENT_MODEL_PREFERENCE_KEY);
  });
});

describe('startAgent retry semantics', () => {
  it('keeps the persisted safe-retry key and the row when the backend is retryable', async () => {
    prepareSessionMutate.mockRejectedValueOnce(serviceUnavailableError());

    const first = await startAgent({ prompt: 'fix the failing build', repository: 'owner/repo' });

    expect(first).toMatchObject({ ok: false, code: 'start-failed', retryable: true });
    expect(removeOutboxRow).not.toHaveBeenCalled();
    const persistedRow = writtenRow();

    // A relaunch: the in-process key holder is gone, so only the persisted
    // row can carry the key into the retry.
    const runtime = await import('@/lib/app-actions/start-agent-runtime');
    runtime.rotateKey();
    listOutboxRows.mockResolvedValue([persistedRow]);
    prepareSessionMutate.mockResolvedValueOnce({ kiloSessionId: SESSION_ID });

    const second = await startAgent({ prompt: 'fix the failing build', repository: 'owner/repo' });

    expect(second.ok).toBe(true);
    const keys = usedOperationKeys();
    expect(keys[1]).toBe(persistedRow.operationKey);
    expect(keys[1]).toBe(keys[0]);
    expect(writtenRow(1).operationKey).toBe(persistedRow.operationKey);
  });

  it('rotates the key and drops the row on a terminal rejection', async () => {
    prepareSessionMutate.mockRejectedValueOnce(badRequestError());

    const first = await startAgent({ prompt: 'fix the failing build', repository: 'owner/repo' });

    expect(first).toMatchObject({ ok: false, code: 'start-failed', retryable: false });
    expect(removeOutboxRow).toHaveBeenCalledTimes(1);
    expect(removeOutboxRow).toHaveBeenCalledWith('user-1', writtenRow().fingerprint);

    prepareSessionMutate.mockResolvedValueOnce({ kiloSessionId: SESSION_ID });
    await startAgent({ prompt: 'fix the failing build', repository: 'owner/repo' });

    const keys = usedOperationKeys();
    expect(keys[1]).not.toBe(keys[0]);
  });

  it('refuses the intent when the stored rows could not be read', async () => {
    listOutboxRows.mockResolvedValue(null);

    const result = await startAgent({ prompt: 'fix the failing build', repository: 'owner/repo' });

    expect(result).toMatchObject({ ok: false, code: 'start-failed', retryable: true });
    expect(prepareSessionMutate).not.toHaveBeenCalled();
    expect(writeOutboxRow).not.toHaveBeenCalled();
  });
});

describe('startAgent failure codes', () => {
  it('reports an empty prompt when neither a prompt nor a session is present', async () => {
    const result = await startAgent({ prompt: '   ' });

    expect(result).toMatchObject({
      ok: false,
      action: 'StartAgent',
      code: 'empty-prompt',
      retryable: false,
      message: i18n.t('appActions.start.promptRequired'),
    });
    expect(prepareSessionMutate).not.toHaveBeenCalled();
  });

  it('reports no-repository when nothing was used recently', async () => {
    recentRepositoriesQuery.mockResolvedValue({ repositories: [] });

    const result = await startAgent({ prompt: 'fix the failing build' });

    expect(result).toMatchObject({
      ok: false,
      code: 'no-repository',
      retryable: false,
      message: i18n.t('agentChat.newSession.noRepositoriesVisible'),
    });
    expect(prepareSessionMutate).not.toHaveBeenCalled();
  });

  it('reports unsupported-repository for a Bitbucket repository', async () => {
    const result = await startAgent({
      prompt: 'fix the failing build',
      repository: 'https://bitbucket.org/workspace/repo',
    });

    expect(result).toMatchObject({
      ok: false,
      code: 'unsupported-repository',
      retryable: false,
      message: i18n.t('appActions.start.repositoryUnsupported', { repository: 'workspace/repo' }),
    });
    expect(prepareSessionMutate).not.toHaveBeenCalled();
  });

  it('reports unsupported-repository when only a Bitbucket repository was used recently', async () => {
    recentRepositoriesQuery.mockResolvedValue({
      repositories: [{ gitUrl: 'git@bitbucket.org:workspace/repo.git', lastUsedAt: '2026-09-15' }],
    });

    const result = await startAgent({ prompt: 'fix the failing build' });

    expect(result).toMatchObject({
      ok: false,
      code: 'unsupported-repository',
      retryable: false,
      message: i18n.t('appActions.start.repositoryUnsupported', { repository: 'workspace/repo' }),
    });
    expect(prepareSessionMutate).not.toHaveBeenCalled();
  });

  it('reports unknown-repository for a host that is not a known provider', async () => {
    const result = await startAgent({
      prompt: 'fix the failing build',
      repository: 'https://git.example.com/owner/repo',
    });

    expect(result).toMatchObject({
      ok: false,
      code: 'unknown-repository',
      retryable: false,
      message: i18n.t('appActions.start.repositoryUnknown', {
        repository: 'https://git.example.com/owner/repo',
      }),
    });
    expect(prepareSessionMutate).not.toHaveBeenCalled();
  });

  it('reports a retryable start-failed for a transient backend failure', async () => {
    prepareSessionMutate.mockRejectedValueOnce(serviceUnavailableError());

    const result = await startAgent({ prompt: 'fix the failing build', repository: 'owner/repo' });

    expect(result).toMatchObject({
      ok: false,
      code: 'start-failed',
      retryable: true,
      message: i18n.t('agentChat.session.serviceUnavailable'),
    });
  });

  it('reports a non-retryable start-failed when the model catalogue is unusable', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });

    const result = await startAgent({ prompt: 'fix the failing build', repository: 'owner/repo' });

    expect(result).toMatchObject({
      ok: false,
      code: 'start-failed',
      retryable: false,
      message: i18n.t('agentChat.newSession.failedToCreate'),
    });
    expect(prepareSessionMutate).not.toHaveBeenCalled();
  });
});

describe('startAgent continue variant', () => {
  it('sends the clone body: cloneFromKiloSessionId, autoInitiate, operationKey, no prompt', async () => {
    const result = await startAgent({
      prompt: '',
      sessionId: SESSION_ID,
      repository: 'owner/repo',
    });

    expect(result).toMatchObject({ ok: true, sessionId: SESSION_ID });
    const body = prepareSessionMutate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body).toMatchObject({
      mode: 'code',
      model: 'anthropic/claude',
      variant: 'low',
      githubRepo: 'owner/repo',
      autoCommit: false,
      autoInitiate: true,
      cloneFromKiloSessionId: SESSION_ID,
      operationKey: expect.any(String),
    });
    expect(body).not.toHaveProperty('prompt');
    expect(body).not.toHaveProperty('initialMessageId');
    // The clone schema carries exactly these fields — nothing else leaks in.
    expect(new Set(Object.keys(body))).toEqual(
      new Set([
        'autoCommit',
        'autoInitiate',
        'cloneFromKiloSessionId',
        'githubRepo',
        'mode',
        'model',
        'operationKey',
        'variant',
      ])
    );
  });

  it('continues even when the prompt is blank and a session is named', async () => {
    const result = await startAgent({
      prompt: '   ',
      sessionId: SESSION_ID,
      repository: 'owner/repo',
    });

    expect(result.ok).toBe(true);
    expect(prepareSessionMutate).toHaveBeenCalledTimes(1);
  });
});
