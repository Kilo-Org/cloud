import type { ListedSession } from '@kilocode/cloud-agent-sdk';

import type { ChatSummary } from '../store';
import type { SyncRecord } from './sync-store';

/**
 * The merged chat list: local chats and server sessions as one row type.
 * A local chat that syncs merges with its server row (live, archived and
 * origin come from the server; title and preview stay the local ones the
 * person reads). Server sessions with no local chat stand alone and import
 * on open. Pure, so the merge is testable without a query.
 */

export type ChatOrigin = 'mobile' | 'cli' | 'cloud-agent';

export type MergedChatRow = {
  /** The FlashList key: the local session id when there is one, else the server id. */
  readonly key: string;
  readonly title: string;
  readonly preview: string;
  readonly model: string;
  readonly updatedAt: number;
  readonly live: boolean;
  readonly archived: boolean;
  readonly origin: ChatOrigin | null;
  /** The harness session to open, when this device holds the chat. */
  readonly localSessionId: string | null;
  readonly serverSessionId: string | null;
  readonly chat: ChatSummary | null;
};

export type ChatListFilters = {
  readonly q: string;
  readonly origin: 'all' | 'mobile' | 'cli';
  readonly includeArchived: boolean;
};

export const DEFAULT_CHAT_FILTERS: ChatListFilters = {
  q: '',
  origin: 'all',
  includeArchived: false,
};

/** The `listSessions` parameters one filter set names. */
export function serverListParams(filters: ChatListFilters): {
  readonly q?: string;
  readonly client?: 'cli' | 'mobile';
  readonly archived?: boolean;
} {
  return {
    ...(filters.q.trim() === '' ? {} : { q: filters.q.trim() }),
    ...(filters.origin === 'all' ? {} : { client: filters.origin }),
    ...(filters.includeArchived ? {} : { archived: false }),
  };
}

function matchesLocal(chat: ChatSummary, filters: ChatListFilters): boolean {
  if (filters.origin === 'cli') {
    return false;
  }
  const q = filters.q.trim().toLowerCase();
  return q === '' || chat.title.toLowerCase().includes(q);
}

export function mergeChatRows(input: {
  readonly chats: readonly ChatSummary[];
  readonly records: readonly SyncRecord[];
  readonly listed: readonly ListedSession[];
  readonly filters: ChatListFilters;
}): MergedChatRow[] {
  const listedById = new Map(input.listed.map(one => [one.sessionID, one]));
  const recordByLocal = new Map(input.records.map(one => [one.sessionId, one]));
  const heldServerIds = new Set<string>();
  const rows: MergedChatRow[] = [];
  for (const chat of input.chats) {
    const record = recordByLocal.get(chat.sessionId);
    const server = record?.serverSessionId === null || record?.serverSessionId === undefined
      ? undefined
      : listedById.get(record.serverSessionId);
    if (server !== undefined) {
      heldServerIds.add(server.sessionID);
    }
    if (server === undefined && !matchesLocal(chat, input.filters)) {
      continue;
    }
    if (server !== undefined && server.archived && !input.filters.includeArchived) {
      continue;
    }
    rows.push({
      key: chat.sessionId,
      title: chat.title !== '' ? chat.title : (server?.title ?? ''),
      preview: chat.preview,
      model: chat.model,
      updatedAt: Math.max(chat.updatedAt, server?.updatedAt ?? 0),
      live: server?.live ?? false,
      archived: server?.archived ?? false,
      origin: server?.client ?? (record?.serverSessionId === null || record === undefined ? null : 'mobile'),
      localSessionId: chat.sessionId,
      serverSessionId: record?.serverSessionId ?? null,
      chat,
    });
  }
  for (const server of input.listed) {
    if (heldServerIds.has(server.sessionID)) {
      continue;
    }
    rows.push({
      key: server.sessionID,
      title: server.title ?? '',
      preview: '',
      model: '',
      updatedAt: server.updatedAt,
      live: server.live,
      archived: server.archived,
      origin: server.client,
      localSessionId: null,
      serverSessionId: server.sessionID,
      chat: null,
    });
  }
  return rows.sort((one, other) => other.updatedAt - one.updatedAt || (one.key < other.key ? 1 : -1));
}

/** The four-state surface of the merged list read. */
export type SyncedListSurface =
  | { readonly kind: 'off' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'retryable-error' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'ready'; readonly rows: readonly MergedChatRow[] };

export function selectSyncedListSurface(input: {
  readonly enabled: boolean;
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly isPaused: boolean;
  readonly rows: readonly MergedChatRow[];
}): SyncedListSurface {
  if (!input.enabled) {
    return { kind: 'off' };
  }
  if (input.rows.length > 0) {
    return { kind: 'ready', rows: input.rows };
  }
  if (input.isPaused) {
    return { kind: 'retryable-error' };
  }
  if (input.isError) {
    return { kind: 'failed' };
  }
  if (input.isPending) {
    return { kind: 'loading' };
  }
  return { kind: 'ready', rows: input.rows };
}
