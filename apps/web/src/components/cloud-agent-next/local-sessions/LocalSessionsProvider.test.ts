import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createRequire } from 'node:module';
import React, { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { generateKiloSessionId } from '@kilocode/session-ingest-contracts';
import {
  LocalSessionsProvider,
  useLocalSessions,
  type LocalSessionDraft,
  type SendLocalSession,
} from './LocalSessionsProvider';
import { writeStoredLocalSessions } from './local-session-storage';

const draft: LocalSessionDraft = {
  organizationId: null,
  worktreeId: null,
  repository: 'kilo/repo',
  branch: 'main',
  composer: null,
  firstMessage: { id: 'message-1', prompt: 'Fix this', attachmentNames: ['notes.txt'] },
  request: {
    kind: 'new-session',
    input: {
      githubRepo: 'kilo/repo',
      prompt: 'Fix this',
      mode: 'code',
      model: 'test/model',
      attachments: { path: 'message-1', files: ['notes.txt'] },
    },
  },
};

const definitiveError = { message: 'Not allowed', data: { code: 'FORBIDDEN' } };
let sessions: ReturnType<typeof useLocalSessions>;

function Probe() {
  sessions = useLocalSessions();
  return null;
}

describe('LocalSessionsProvider discard ownership', () => {
  let root: Root;
  let previous: Record<string, unknown>;
  const onDiscard = jest.fn<(session: Parameters<SendLocalSession>[0]) => void>();
  const onAdopted = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    const requireFromHere = createRequire(__filename);
    let linkedom: string;
    try {
      linkedom = requireFromHere.resolve('linkedom');
    } catch {
      linkedom = '../../../../../../node_modules/.pnpm/linkedom@0.18.12/node_modules/linkedom';
    }
    const { parseHTML } = requireFromHere(linkedom) as {
      parseHTML: (html: string) => { window: Window; document: Document };
    };
    const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
    const storage = new Map<string, string>();
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
    });
    previous = {
      React: (globalThis as { React?: typeof React }).React,
      window: globalThis.window,
      document: globalThis.document,
      IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
        .IS_REACT_ACT_ENVIRONMENT,
    };
    Object.assign(globalThis, { React, window, document, IS_REACT_ACT_ENVIRONMENT: true });
    const container = document.getElementById('root');
    if (!container) throw new Error('Missing root');
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    jest.useRealTimers();
    Object.assign(globalThis, previous);
  });

  function mount(send: SendLocalSession) {
    act(() => {
      root.render(
        createElement(LocalSessionsProvider, {
          storageKey: 'test',
          send,
          onAdopted,
          onDiscard,
          children: createElement(Probe),
        })
      );
    });
  }

  async function create() {
    let id = '';
    await act(async () => {
      id = sessions.createLocalSession(draft);
    });
    return id;
  }

  it('cleans up a definitively failed session once and restores its prompt', async () => {
    mount(async () => {
      throw definitiveError;
    });
    const id = await create();
    expect(sessions.localSessions[0]?.sync).toMatchObject({
      state: 'failed',
      retrySameAttempt: false,
    });
    const failed = sessions.localSessions[0];

    act(() => {
      sessions.discardLocalSession(id);
      sessions.discardLocalSession(id);
    });

    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect(onDiscard).toHaveBeenCalledWith(failed);
    expect(sessions.localSessions).toEqual([]);
    expect(sessions.discardedPrompt).toBe('Fix this');
  });

  it.each([
    new Error('Network disconnected'),
    { message: 'Timed out', data: { code: 'TIMEOUT' } },
    { message: 'Server error', data: { code: 'INTERNAL_SERVER_ERROR' } },
  ])('does not clean up an ambiguous failure: %j', async error => {
    mount(async () => {
      throw error;
    });
    const id = await create();
    expect(sessions.localSessions[0]?.sync).toMatchObject({
      state: 'failed',
      retrySameAttempt: true,
    });

    act(() => sessions.discardLocalSession(id));

    expect(sessions.localSessions).toEqual([]);
    expect(onDiscard).not.toHaveBeenCalled();
  });

  it('retains uploads on retry, including discard before the retry renders', async () => {
    const send = jest
      .fn<SendLocalSession>()
      .mockRejectedValueOnce(definitiveError)
      .mockImplementation(() => new Promise(() => {}));
    mount(send);
    const id = await create();

    act(() => {
      const retriedId = sessions.retryLocalSession(id);
      if (!retriedId) throw new Error('Retry did not start');
      sessions.discardLocalSession(retriedId);
    });

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]?.[0].request).toEqual(draft.request);
    expect(onDiscard).not.toHaveBeenCalled();
  });

  it('retains uncertainty after an ambiguous attempt is retried and fails definitively', async () => {
    const send = jest
      .fn<SendLocalSession>()
      .mockRejectedValueOnce(new Error('Network disconnected'))
      .mockRejectedValueOnce(definitiveError);
    mount(send);
    const id = await create();

    await act(async () => {
      expect(sessions.retryLocalSession(id)).toBe(id);
    });
    expect(sessions.localSessions[0]?.sync).toMatchObject({
      state: 'failed',
      retrySameAttempt: false,
    });
    act(() => sessions.discardLocalSession(id));

    expect(onDiscard).not.toHaveBeenCalled();
  });

  it('does not release a restored request that fails definitively on replay', async () => {
    const id = generateKiloSessionId();
    writeStoredLocalSessions('test', [
      {
        ...draft,
        kiloSessionId: id,
        operationKey: '00000000-0000-4000-8000-000000000001',
        createdAt: '2026-10-21T12:00:00.000Z',
        sync: { state: 'syncing' },
      },
    ]);
    mount(async () => {
      throw definitiveError;
    });
    await act(async () => {});
    expect(sessions.localSessions[0]?.sync).toMatchObject({
      state: 'failed',
      retrySameAttempt: false,
    });

    act(() => sessions.discardLocalSession(id));

    expect(sessions.localSessions).toEqual([]);
    expect(onDiscard).not.toHaveBeenCalled();
  });

  it('does not release after in-progress polling ends in a definitive failure', async () => {
    jest.useFakeTimers();
    const send = jest
      .fn<SendLocalSession>()
      .mockRejectedValueOnce({ message: 'creation_in_progress', data: { code: 'CONFLICT' } })
      .mockRejectedValueOnce(definitiveError);
    mount(send);
    const id = await create();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1000);
    });
    expect(sessions.localSessions[0]?.sync.state).toBe('failed');

    act(() => sessions.discardLocalSession(id));

    expect(onDiscard).not.toHaveBeenCalled();
  });

  it('does not clean up an unresolved request or its late completion', async () => {
    let complete: ((id: string) => void) | undefined;
    mount(
      () =>
        new Promise(resolve => {
          complete = resolve;
        })
    );
    const id = await create();

    act(() => sessions.discardLocalSession(id));
    await act(async () => complete?.(id));

    expect(sessions.localSessions).toEqual([]);
    expect(onDiscard).not.toHaveBeenCalled();
  });

  it('does not clean up sessions reconciled with the server', async () => {
    mount(async () => {
      throw definitiveError;
    });
    const id = await create();

    act(() => sessions.settleLocalSessions(new Set([id]), null));

    expect(sessions.localSessions).toEqual([]);
    expect(onDiscard).not.toHaveBeenCalled();
  });

  it.each(['same-id', 'adopted-id'])('does not clean up a successful %s session', async kind => {
    mount(async (_session, attempt) => (kind === 'same-id' ? attempt.kiloSessionId : 'ses_server'));
    const id = await create();

    act(() => sessions.discardLocalSession(id));

    expect(onDiscard).not.toHaveBeenCalled();
    if (kind === 'adopted-id') expect(onAdopted).toHaveBeenCalledWith(id, 'ses_server');
  });
});
