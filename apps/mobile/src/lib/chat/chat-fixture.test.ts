import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  layerAssembler,
  layerSeededEntropy,
  layerTableCatalog,
  ModelClient,
  ToolRegistry,
} from '@kilocode/harness-sdk';
import { layerNodeStore } from '@kilocode/harness-sdk/plugins/store/node';
import { Layer, Stream } from 'effect';
import { describe, expect, it, vi } from 'vitest';

import { encryptedDatabase } from '@/lib/persist/encrypted-kv';

import { writeChatFixture } from './chat-fixture';
import { enterChat } from './registry';
import { snapshotOf } from './state';
import { rememberChat } from './store';
import { asMessages } from './turns';

/**
 * The fixture against the real registry, the real SDK session store and the
 * app's real `chats` table: what it writes is what the chat route opens, and
 * the state that open settles is the state the screen draws. Only the network
 * edges are replaced (the model, the MCP servers, the tool set), because no
 * fixture state asks a model anything.
 */

const CHATS = [
  '0001_safe_hellfire_club.sql',
  '0002_majestic_old_lace.sql',
  '0003_quick_chat_titles.sql',
]
  .map(file => readFileSync(new URL(`../../../drizzle/${file}`, import.meta.url), 'utf8'))
  .join('--> statement-breakpoint');

const database = vi.hoisted(() => ({ current: undefined as DatabaseSync | undefined }));
const kv = vi.hoisted(() => new Map<string, string>());
/**
 * Makes the next write to this scope refuse, the way a full or closed store
 * does; `close` makes the chat's close refuse after it too.
 */
const refuse = vi.hoisted((): { scope: string | null; close: boolean } => ({
  scope: null,
  close: false,
}));
/** Refuses the next runtime read, which is the first step of closing a chat. */
const backends = vi.hoisted(() => ({ refuseNext: false }));

function sqlite(): DatabaseSync {
  if (database.current === undefined) {
    database.current = new DatabaseSync(':memory:');
    for (const statement of CHATS.split('--> statement-breakpoint')) {
      database.current.exec(statement);
    }
  }
  return database.current;
}

vi.mock('@/lib/persist/encrypted-kv', () => ({
  encryptedDatabase: () =>
    Promise.resolve({
      getAllSync: (source: string, params: (string | number)[]) =>
        sqlite()
          .prepare(source)
          .all(...params),
      runSync: (source: string, params: (string | number)[]) => {
        sqlite()
          .prepare(source)
          .run(...params);
      },
    }),
  getItem: (scope: string, key: string) => Promise.resolve(kv.get(`${scope}:${key}`) ?? null),
  // The fake stores values only, so the timestamped read answers the same value
  // under one fixed time.
  getItemWithUpdatedAt: (scope: string, key: string) => {
    const v = kv.get(`${scope}:${key}`) ?? null;
    return Promise.resolve(v === null ? null : { v, updatedAt: 0 });
  },
  setItem: (scope: string, key: string, value: string) => {
    if (refuse.scope === scope) {
      refuse.scope = null;
      backends.refuseNext = refuse.close;
      return Promise.reject(new Error('the store refused the write'));
    }
    kv.set(`${scope}:${key}`, value);
    return Promise.resolve();
  },
  setItemWithSignal: (scope: string, key: string, write: { value: string }) => {
    kv.set(`${scope}:${key}`, write.value);
    return Promise.resolve();
  },
  removeItem: (scope: string, key: string) => {
    kv.delete(`${scope}:${key}`);
    return Promise.resolve();
  },
}));
vi.mock('./layers', () => ({
  chatLayers: () =>
    Layer.mergeAll(
      layerAssembler,
      layerSeededEntropy(1),
      layerTableCatalog({}, { apiKinds: ['messages'] }),
      Layer.succeed(ToolRegistry, { tools: [] }),
      Layer.succeed(ModelClient, { stream: () => Stream.die('no fixture state asks a model') }),
      layerNodeStore(sqlite())
    ),
  organizationIdOf: () => undefined,
}));
vi.mock('./tools', () => ({
  chatToolNames: () => Promise.resolve([]),
  chatToolNamesStarting: () => [],
}));
vi.mock('./kilo-mcp', () => ({
  ensureKiloMcp: () => Promise.resolve({ status: 'ready', tools: [] }),
  mcpChoiceFor: () => Promise.resolve(null),
  mcpEnabledFor: () => Promise.resolve(true),
  setMcpEnabled: () => Promise.resolve(),
  moveMcpEnabled: () => Promise.resolve(),
  kiloMcpTools: () => [],
  kiloMcpToolNames: () => [],
}));
vi.mock('./remote-mcp', () => ({
  ensureRemoteMcp: () => Promise.resolve([]),
  remoteServerTools: () => [],
  remoteServerToolNames: () => [],
}));
vi.mock('./backend-store', () => ({
  listChatBackends: () => [],
  waitForChatBackends: () => {
    if (backends.refuseNext) {
      backends.refuseNext = false;
      return Promise.reject(new Error('the close was refused'));
    }
    return Promise.resolve();
  },
}));
vi.mock('./local-models', () => ({ localModelProvider: () => undefined }));
vi.mock('@/lib/config', () => ({ KILO_MCP_URL: undefined }));

const place = { chatScope: 'me:personal', org: { kind: 'personal' } } as const;

/** What the chat route settles on: its state, and whether the failure owns the screen. */
async function opened(sessionId: string) {
  await enterChat(place, sessionId);
  const state = snapshotOf(sessionId);
  const messages = asMessages(state);
  return {
    state,
    messages,
    transcriptFailure: state.status === 'idle' && messages.length === 0 ? state.failureKey : null,
  };
}

describe('the chat fixture, opened by the chat route', () => {
  it('opens a chat with nothing said on the empty state', async () => {
    const { state, messages, transcriptFailure } = await opened(
      await writeChatFixture(place, 'empty')
    );
    expect(state.status).toBe('idle');
    expect(state.failureKey).toBeNull();
    expect(messages).toHaveLength(0);
    expect(transcriptFailure).toBeNull();
  });

  it('opens a question whose answer failed, with its bubble and the transient cause', async () => {
    const { state, messages, transcriptFailure } = await opened(
      await writeChatFixture(place, 'failed')
    );
    expect(state.asked).toBe('Summarize the open pull requests for me.');
    expect(state.failureKey).toBe('common.somethingWentWrong');
    expect(messages).toHaveLength(1);
    expect(transcriptFailure).toBeNull();
  });

  it('opens a question the balance refused, with the credits cause', async () => {
    const { state, messages } = await opened(await writeChatFixture(place, 'credits'));
    expect(state.failureKey).toBe('modelChat.creditsRequired');
    expect(messages).toHaveLength(1);
  });

  it('opens twelve kept questions before the failed one', async () => {
    const { state, messages } = await opened(await writeChatFixture(place, 'long'));
    expect(state.displaced).toHaveLength(12);
    expect(state.asked).toContain('```ts');
    expect(messages).toHaveLength(13);
  });

  it('opens a chat with only the app row on the failure, which is why the fixture starts one', async () => {
    rememberChat(await encryptedDatabase(), {
      sessionId: 'row-only',
      scope: place.chatScope,
      at: Date.now(),
    });
    const { transcriptFailure } = await opened('row-only');
    expect(transcriptFailure).toBe('common.somethingWentWrong');
  });

  it.each([
    ['the close succeeds', false],
    ['the close is refused too', true],
  ])(
    'deletes the started chat when a record write fails and %s, so Retry leaves no row behind',
    async (_case, refuseClose) => {
      const count = (table: 'chats' | 'sessions') =>
        sqlite().prepare(`select count(*) as n from ${table}`).get();
      const before = { chats: count('chats'), sessions: count('sessions') };
      refuse.scope = 'chat-asked-target';
      refuse.close = refuseClose;
      await expect(writeChatFixture(place, 'failed')).rejects.toThrow(
        'the store refused the write'
      );
      expect(backends.refuseNext).toBe(false);
      expect({ chats: count('chats'), sessions: count('sessions') }).toEqual(before);
    }
  );
});
