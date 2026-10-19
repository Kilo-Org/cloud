import type { CustomerBillingFailure } from '@kilocode/cloud-agent-sdk';
import type { StoredMessage, StoredSession } from '../types';
import { getChatDisplayTitle } from '../utils/session-title';
import type { LocalSessionRequest } from './local-session-request';

/** The ids one create request sends; a retry of the same request reuses both. */
export type LocalSessionAttempt = { kiloSessionId: string; operationKey: string };

export type LocalSessionSync =
  | { state: 'syncing' }
  | { state: 'synced' }
  | {
      state: 'failed';
      message: string;
      /** The outcome is unknown, so a retry must repeat the same attempt. */
      retrySameAttempt: boolean;
      billingFailure: CustomerBillingFailure | null;
    };

/** The composer settings a new chat copies from the chat it was created from. */
export type LocalComposerSettings = { mode: string; model: string; variant: string | null };

/** The prompt a new session starts with; the server keeps its message id. */
export type LocalFirstMessage = { id: string; prompt: string; attachmentNames: string[] };

/**
 * A session the client has created but the server lists do not show yet. The
 * UI reads it like any other session, under its final id, from the first frame.
 */
export type LocalSession = LocalSessionAttempt & {
  organizationId: string | null;
  worktreeId: string | null;
  request: LocalSessionRequest;
  repository: string;
  branch: string | null;
  composer: LocalComposerSettings | null;
  firstMessage: LocalFirstMessage | null;
  createdAt: string;
  sync: LocalSessionSync;
};

/** The chat the server copies a new chat's setup from; null for a new session. */
export function localSessionSourceId(session: LocalSession): string | null {
  return session.request.kind === 'worktree-chat' ? session.request.sourceKiloSessionId : null;
}

export function toStoredSession(session: LocalSession): StoredSession {
  return {
    sessionId: session.kiloSessionId,
    repository: session.repository,
    branch: session.branch,
    worktreeId: session.worktreeId,
    prompt: getChatDisplayTitle(null),
    mode: 'code',
    model: '',
    status: 'active',
    createdAt: session.createdAt,
    updatedAt: session.createdAt,
    messages: [],
    cloudAgentSessionId: null,
    createdOnPlatform: 'cloud-agent-web',
    localSync: session.sync.state,
  };
}

/**
 * The transcript known before the server has the session: the first prompt, in
 * the shape of the SDK's optimistic row, so the live row replaces it by id.
 */
export function localTranscript(session: LocalSession): StoredMessage[] {
  const message = session.firstMessage;
  if (!message) return [];
  const sessionID = session.kiloSessionId;
  return [
    {
      info: {
        id: message.id,
        sessionID,
        role: 'user',
        time: { created: new Date(session.createdAt).getTime() },
        agent: '',
        model: { providerID: '', modelID: '' },
        synthetic: true,
      },
      parts: [
        {
          id: `${message.id}-text`,
          sessionID,
          messageID: message.id,
          type: 'text',
          text: message.prompt,
          synthetic: true,
        },
      ],
    },
  ];
}

/**
 * Server rows win by id. Local sessions of the same organization that the server
 * does not list yet come first, newest first, as the most recent activity.
 */
export function withLocalSessions(
  sessions: StoredSession[],
  localSessions: readonly LocalSession[],
  organizationId: string | null
): StoredSession[] {
  if (localSessions.length === 0) return sessions;
  const listedIds = new Set(sessions.map(session => session.sessionId));
  const unlisted = localSessions
    .filter(
      session => session.organizationId === organizationId && !listedIds.has(session.kiloSessionId)
    )
    .map(toStoredSession)
    .reverse();
  return unlisted.length === 0 ? sessions : [...unlisted, ...sessions];
}

/**
 * A worktree holding a session created here is known to be new and untitled, so
 * its row shows that at once instead of waiting for the server's details.
 */
export function withLocalWorktreeDetails<Details>(
  details: Record<string, Details>,
  sessions: readonly StoredSession[],
  localSessionIds: ReadonlySet<string>,
  untitled: Details
): Record<string, Details> {
  let known: Record<string, Details> | null = null;
  for (const session of sessions) {
    const worktreeId = session.worktreeId;
    if (!worktreeId || worktreeId in details || !localSessionIds.has(session.sessionId)) continue;
    known ??= { ...details };
    known[worktreeId] = untitled;
  }
  return known ?? details;
}

/**
 * Applies what the server lists. A listed session exists there, so a failure seen
 * here was not final: it counts as synced. A synced session is dropped once
 * listed, except the open one, which the page still treats as known until its
 * live transcript loads. A session still syncing waits for its own reply.
 */
export function reconcileLocalSessions(
  sessions: readonly LocalSession[],
  listedIds: ReadonlySet<string>,
  openSessionId: string | null
): readonly LocalSession[] {
  let changed = false;
  const next = sessions.flatMap(session => {
    const listed = listedIds.has(session.kiloSessionId);
    if (!listed || session.sync.state === 'syncing') return [session];
    if (session.kiloSessionId !== openSessionId) {
      changed = true;
      return [];
    }
    if (session.sync.state === 'synced') return [session];
    changed = true;
    return [{ ...session, sync: { state: 'synced' as const } }];
  });
  return changed ? next : sessions;
}
