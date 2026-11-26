import { type ListedSession } from '@kilocode/cloud-agent-sdk';
import { describe, expect, it } from 'vitest';

import { type ChatSummary } from '../store';
import {
  DEFAULT_CHAT_FILTERS,
  mergeChatRows,
  selectSyncedListSurface,
  serverListParams,
} from './sync-list';
import { type SyncRecord } from './sync-store';

const chat = (over: Partial<ChatSummary> = {}): ChatSummary => ({
  sessionId: 'ses_local1',
  model: 'kilo/test',
  title: 'Local chat',
  preview: 'newest words',
  updatedAt: 1000,
  ...over,
});

const record = (over: Partial<SyncRecord> = {}): SyncRecord => ({
  sessionId: 'ses_local1',
  serverSessionId: 'ses_server1',
  sourceId: 'source-mobile',
  phase: 'synced',
  acknowledged: 4,
  ackBatch: 'b',
  ackDigest: 'd',
  maxSeq: 4,
  ackedSeq: 4,
  outbox: null,
  messageMap: {},
  ...over,
});

const listed = (over: Partial<ListedSession> = {}): ListedSession => ({
  sessionID: 'ses_server1',
  tenant: { type: 'user', id: 'u1' },
  createdAt: 1000,
  updatedAt: 2000,
  title: 'Server title',
  client: 'mobile',
  directory: null,
  archived: false,
  live: false,
  ...over,
});

describe('mergeChatRows', () => {
  it('merges a synced local chat with its server row, keeping the local preview', () => {
    const [row] = mergeChatRows({
      chats: [chat()],
      records: [record()],
      listed: [listed({ live: true })],
      filters: DEFAULT_CHAT_FILTERS,
    });
    expect(row).toMatchObject({
      key: 'ses_local1',
      localSessionId: 'ses_local1',
      serverSessionId: 'ses_server1',
      live: true,
      origin: 'mobile',
      preview: 'newest words',
      updatedAt: 2000,
    });
    expect(row?.title).toBe('Local chat');
  });

  it('adds a CLI session this device holds no chat for', () => {
    const rows = mergeChatRows({
      chats: [],
      records: [],
      listed: [listed({ sessionID: 'ses_cli', client: 'cli', title: 'CLI work' })],
      filters: DEFAULT_CHAT_FILTERS,
    });
    expect(rows).toEqual([
      expect.objectContaining({
        key: 'ses_cli',
        localSessionId: null,
        serverSessionId: 'ses_cli',
        origin: 'cli',
        title: 'CLI work',
      }),
    ]);
  });

  it('hides archived rows unless asked, and filters by origin and query', () => {
    const rows = mergeChatRows({
      chats: [],
      records: [],
      listed: [
        listed({ sessionID: 'a', archived: true }),
        listed({ sessionID: 'b', client: 'cli', title: 'Deploy fix' }),
        listed({ sessionID: 'c', client: 'mobile', title: 'Recipe' }),
      ],
      filters: DEFAULT_CHAT_FILTERS,
    });
    expect(rows.map(row => row.key).sort()).toEqual(['b', 'c']);
    const archived = mergeChatRows({
      chats: [],
      records: [],
      listed: [listed({ sessionID: 'a', archived: true })],
      filters: { ...DEFAULT_CHAT_FILTERS, includeArchived: true },
    });
    expect(archived).toHaveLength(1);
    const cliOnly = mergeChatRows({
      chats: [chat()],
      records: [record()],
      listed: [listed(), listed({ sessionID: 'b', client: 'cli' })],
      filters: { ...DEFAULT_CHAT_FILTERS, origin: 'cli' },
    });
    expect(cliOnly.map(row => row.key)).toEqual(['b']);
  });

  it('orders newest first', () => {
    const rows = mergeChatRows({
      chats: [],
      records: [],
      listed: [
        listed({ sessionID: 'old', updatedAt: 100 }),
        listed({ sessionID: 'new', updatedAt: 900 }),
      ],
      filters: DEFAULT_CHAT_FILTERS,
    });
    expect(rows.map(row => row.key)).toEqual(['new', 'old']);
  });
});

describe('serverListParams', () => {
  it('names the server filters one set asks for', () => {
    expect(serverListParams(DEFAULT_CHAT_FILTERS)).toEqual({ archived: false });
    expect(serverListParams({ q: ' bug ', origin: 'cli', includeArchived: true })).toEqual({
      q: 'bug',
      client: 'cli',
    });
  });
});

describe('selectSyncedListSurface', () => {
  const ready = { isPending: false, isError: false, isPaused: false };

  it('is off without the gate, even with a failed read', () => {
    expect(
      selectSyncedListSurface({
        enabled: false,
        isPending: true,
        isError: true,
        isPaused: true,
        rows: [],
      })
    ).toEqual({ kind: 'off' });
  });

  it('is loading, retryable or failed with nothing to draw', () => {
    expect(
      selectSyncedListSurface({
        enabled: true,
        isPending: true,
        isError: false,
        isPaused: false,
        rows: [],
      }).kind
    ).toBe('loading');
    expect(
      selectSyncedListSurface({
        enabled: true,
        isPending: false,
        isError: true,
        isPaused: true,
        rows: [],
      }).kind
    ).toBe('retryable-error');
    expect(
      selectSyncedListSurface({
        enabled: true,
        isPending: false,
        isError: true,
        isPaused: false,
        rows: [],
      }).kind
    ).toBe('failed');
  });

  it('keeps the rows it has over a later failure, and answers and empty list as ready', () => {
    const rows = [
      {
        key: 'k',
        title: 't',
        preview: '',
        model: '',
        updatedAt: 1,
        live: false,
        archived: false,
        origin: null,
        localSessionId: null,
        serverSessionId: null,
        chat: null,
      },
    ];
    expect(
      selectSyncedListSurface({
        enabled: true,
        isError: true,
        isPaused: true,
        isPending: false,
        rows,
      }).kind
    ).toBe('ready');
    expect(selectSyncedListSurface({ enabled: true, rows: [], ...ready })).toEqual({
      kind: 'ready',
      rows: [],
    });
  });
});
