'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { v4 as uuidv4 } from 'uuid';
import { formatSessionError, parseCustomerBillingFailure } from '@kilocode/cloud-agent-sdk';
import { generateKiloSessionId } from '@kilocode/session-ingest-contracts';
import {
  isAmbiguousCloudSessionCreationError,
  isCloudSessionCreationInProgressError,
} from '../types';
import {
  reconcileLocalSessions,
  type LocalSession,
  type LocalSessionAttempt,
  type LocalSessionSync,
} from './local-session';
import { readStoredLocalSessions, writeStoredLocalSessions } from './local-session-storage';

/** Sends one attempt of a session's request; resolves with the id the server used. */
export type SendLocalSession = (
  session: LocalSession,
  attempt: LocalSessionAttempt
) => Promise<string>;

export type LocalSessionDraft = Omit<
  LocalSession,
  'kiloSessionId' | 'operationKey' | 'createdAt' | 'sync'
>;

/** Waits before asking again while an earlier attempt still runs on the server. */
const IN_PROGRESS_RETRY_DELAYS_MS = [1000, 2000, 4000];

type LocalSessionsValue = {
  localSessions: readonly LocalSession[];
  /** False until stored sessions of this tab are back; a page connects only after. */
  restored: boolean;
  /** Adds the session under a new client id and sends its request. Returns the id. */
  createLocalSession: (draft: LocalSessionDraft) => string;
  /**
   * Retries a failed session and returns the id it continues under. A failure with
   * a known outcome may still own the old id, so that retry moves to a new id.
   */
  retryLocalSession: (kiloSessionId: string) => string | null;
  /** Drops the session; a discarded first prompt goes back to the new-session form. */
  discardLocalSession: (kiloSessionId: string) => void;
  /** The first prompt of the last discarded new session, for the new-session form. */
  discardedPrompt: string | null;
  clearDiscardedPrompt: () => void;
  /** Drops synced sessions that the server lists now. */
  settleLocalSessions: (listedIds: ReadonlySet<string>, openSessionId: string | null) => void;
};

const LocalSessionsContext = createContext<LocalSessionsValue>({
  localSessions: [],
  restored: true,
  createLocalSession: () => {
    throw new Error('LocalSessionsProvider is missing');
  },
  retryLocalSession: () => null,
  discardLocalSession: () => {},
  discardedPrompt: null,
  clearDiscardedPrompt: () => {},
  settleLocalSessions: () => {},
});

function attemptOf(session: LocalSessionAttempt): LocalSessionAttempt {
  return { kiloSessionId: session.kiloSessionId, operationKey: session.operationKey };
}

function newAttempt(): LocalSessionAttempt {
  return { kiloSessionId: generateKiloSessionId(), operationKey: uuidv4() };
}

function failedSync(error: unknown): LocalSessionSync {
  return {
    state: 'failed',
    message: formatSessionError(error),
    retrySameAttempt: isAmbiguousCloudSessionCreationError(error),
    billingFailure: parseCustomerBillingFailure(error),
  };
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export function LocalSessionsProvider({
  storageKey,
  send,
  onAdopted,
  children,
}: {
  storageKey: string;
  send: SendLocalSession;
  /** The server created a session under its own id (an older server). */
  onAdopted: (localId: string, serverId: string) => void;
  children: ReactNode;
}) {
  const [localSessions, setLocalSessions] = useState<readonly LocalSession[]>([]);
  const [restored, setRestored] = useState(false);
  const [discardedPrompt, setDiscardedPrompt] = useState<string | null>(null);
  const localSessionsRef = useRef(localSessions);
  localSessionsRef.current = localSessions;
  const sendRef = useRef(send);
  sendRef.current = send;
  const onAdoptedRef = useRef(onAdopted);
  onAdoptedRef.current = onAdopted;

  const run = useCallback(async (session: LocalSession, attempt: LocalSessionAttempt) => {
    const isCurrent = (item: LocalSession) =>
      item.kiloSessionId === attempt.kiloSessionId && item.operationKey === attempt.operationKey;
    const settle = (next: LocalSessionSync) =>
      setLocalSessions(previous =>
        previous.map(item => (isCurrent(item) ? { ...item, sync: next } : item))
      );
    for (let tries = 0; ; tries++) {
      try {
        const serverId = await sendRef.current(session, attempt);
        if (serverId === attempt.kiloSessionId) {
          settle({ state: 'synced' });
        } else {
          setLocalSessions(previous => previous.filter(item => !isCurrent(item)));
          onAdoptedRef.current(attempt.kiloSessionId, serverId);
        }
        return;
      } catch (error) {
        const delay = IN_PROGRESS_RETRY_DELAYS_MS[tries];
        if (delay === undefined || !isCloudSessionCreationInProgressError(error)) {
          settle(failedSync(error));
          return;
        }
        await wait(delay);
        if (!localSessionsRef.current.some(isCurrent)) return;
      }
    }
  }, []);

  // Runs before the page's next layout effects, so a reloaded page sees its local
  // session before it decides whether to connect.
  useLayoutEffect(() => {
    const stored = readStoredLocalSessions(storageKey).filter(
      session => session.sync.state !== 'synced'
    );
    localSessionsRef.current = stored;
    setLocalSessions(stored);
    setRestored(true);
    for (const session of stored) {
      if (session.sync.state === 'syncing') void run(session, attemptOf(session));
    }
  }, [run, storageKey]);

  useEffect(() => {
    if (restored) writeStoredLocalSessions(storageKey, localSessions);
  }, [localSessions, restored, storageKey]);

  const createLocalSession = useCallback(
    (draft: LocalSessionDraft) => {
      const attempt = newAttempt();
      const session: LocalSession = {
        ...draft,
        ...attempt,
        createdAt: new Date().toISOString(),
        sync: { state: 'syncing' },
      };
      localSessionsRef.current = [...localSessionsRef.current, session];
      setLocalSessions(previous => [...previous, session]);
      void run(session, attempt);
      return attempt.kiloSessionId;
    },
    [run]
  );

  const retryLocalSession = useCallback(
    (kiloSessionId: string) => {
      const session = localSessionsRef.current.find(item => item.kiloSessionId === kiloSessionId);
      if (!session || session.sync.state !== 'failed') return null;

      const attempt = session.sync.retrySameAttempt
        ? { kiloSessionId, operationKey: session.operationKey }
        : newAttempt();
      const retried: LocalSession = { ...session, ...attempt, sync: { state: 'syncing' } };
      setLocalSessions(previous =>
        previous.map(item => (item.kiloSessionId === kiloSessionId ? retried : item))
      );
      void run(retried, attempt);
      return attempt.kiloSessionId;
    },
    [run]
  );

  const discardLocalSession = useCallback((kiloSessionId: string) => {
    const session = localSessionsRef.current.find(item => item.kiloSessionId === kiloSessionId);
    if (session?.firstMessage) setDiscardedPrompt(session.firstMessage.prompt);
    setLocalSessions(previous => previous.filter(item => item.kiloSessionId !== kiloSessionId));
  }, []);

  const clearDiscardedPrompt = useCallback(() => setDiscardedPrompt(null), []);

  const settleLocalSessions = useCallback(
    (listedIds: ReadonlySet<string>, openSessionId: string | null) => {
      setLocalSessions(previous => reconcileLocalSessions(previous, listedIds, openSessionId));
    },
    []
  );

  const value = useMemo(
    () => ({
      localSessions,
      restored,
      createLocalSession,
      retryLocalSession,
      discardLocalSession,
      discardedPrompt,
      clearDiscardedPrompt,
      settleLocalSessions,
    }),
    [
      localSessions,
      restored,
      createLocalSession,
      retryLocalSession,
      discardLocalSession,
      discardedPrompt,
      clearDiscardedPrompt,
      settleLocalSessions,
    ]
  );
  return <LocalSessionsContext.Provider value={value}>{children}</LocalSessionsContext.Provider>;
}

export function useLocalSessions(): LocalSessionsValue {
  return useContext(LocalSessionsContext);
}

export function useLocalSession(kiloSessionId: string | null): LocalSession | null {
  const { localSessions } = useLocalSessions();
  return localSessions.find(session => session.kiloSessionId === kiloSessionId) ?? null;
}
