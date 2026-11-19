import type { Part } from '@kilocode/app-shared/opencode';
import type { ReadonlyPart } from '../types';
import type { SessionStorage } from './types';
import { clearStorage, deleteMessageFromStorage } from './lifecycle';
import type { StorageContainers } from './lifecycle';
import type {
  PartOrderingEvidence,
  PartViewCache,
  PartsSnapshot,
  SubscriberRegistry,
} from './helpers';
import { createPartViewCache, createReadonlyPartView, createSubscriberRegistry } from './helpers';

/** The containers a lifecycle step mutates, backed by plain maps. */
type Harness = {
  containers: StorageContainers;
  messages: Map<string, unknown>;
  messageIds: string[];
  parts: Map<string, Part[]>;
  snapshot: PartsSnapshot;
  views: PartViewCache;
  evidence: PartOrderingEvidence;
  subscribers: SubscriberRegistry;
};

function createHarness(): Harness {
  const messages = new Map<string, unknown>();
  const parts = new Map<string, Part[]>();
  const snapshot: PartsSnapshot = new Map();
  const views = createPartViewCache();
  const evidence: PartOrderingEvidence = new Map();
  const subscribers = createSubscriberRegistry();
  const harness: Harness = {
    messages,
    messageIds: [],
    parts,
    snapshot,
    views,
    evidence,
    subscribers,
    containers: {
      messages: {
        has: messageId => messages.has(messageId),
        remove: messageId => {
          messages.delete(messageId);
        },
        clear: () => messages.clear(),
        ids: () => harness.messageIds,
        setIds: ids => {
          harness.messageIds = ids;
        },
      },
      parts: {
        get: messageId => parts.get(messageId),
        set: (messageId, arr) => {
          parts.set(messageId, arr);
        },
        has: messageId => parts.has(messageId),
        remove: messageId => {
          parts.delete(messageId);
        },
        messageIds: () => [...parts.keys()],
        clear: () => parts.clear(),
      },
      snapshot,
      views,
      evidence,
      subscribers,
      beforeStructuralChange: () => {},
      publishPartsRevision: () => {},
      publishMessagesRevision: () => {},
    },
  };
  return harness;
}

function makePart(id: string, messageId: string): Part {
  return { id, sessionID: 'ses-1', messageID: messageId, type: 'text', text: id } as Part;
}

/** Record a cached view for a message exactly as a `getParts` rebuild would. */
function primeViews(harness: Harness, messageId: string): void {
  const byPart = new Map<string, { source: Part; view: ReadonlyPart }>();
  for (const part of harness.parts.get(messageId) ?? []) {
    byPart.set(part.id, { source: part, view: createReadonlyPartView(part) });
  }
  harness.views.set(messageId, byPart);
  harness.snapshot.set(
    messageId,
    [...byPart.values()].map(entry => entry.view)
  );
}

describe('deleteMessageFromStorage', () => {
  test('drops the message row, its parts, its snapshot and its cached views', () => {
    const harness = createHarness();
    const storage = {} as SessionStorage;
    harness.messages.set('msg-1', { id: 'msg-1' });
    harness.messageIds = ['msg-1'];
    harness.parts.set('msg-1', [makePart('a', 'msg-1')]);
    primeViews(harness, 'msg-1');

    deleteMessageFromStorage(storage, harness.containers, 'msg-1');

    expect(harness.messages.has('msg-1')).toBe(false);
    expect(harness.messageIds).toEqual([]);
    expect(harness.parts.has('msg-1')).toBe(false);
    expect(harness.snapshot.has('msg-1')).toBe(false);
    // The view cache holds full clones of every part, so a message that is gone
    // must not keep them alive.
    expect(harness.views.has('msg-1')).toBe(false);
  });

  test('keeps another message in the view cache', () => {
    const harness = createHarness();
    const storage = {} as SessionStorage;
    harness.messages.set('msg-1', { id: 'msg-1' });
    harness.messages.set('msg-2', { id: 'msg-2' });
    harness.messageIds = ['msg-1', 'msg-2'];
    harness.parts.set('msg-1', [makePart('a', 'msg-1')]);
    harness.parts.set('msg-2', [makePart('a', 'msg-2')]);
    primeViews(harness, 'msg-1');
    primeViews(harness, 'msg-2');

    deleteMessageFromStorage(storage, harness.containers, 'msg-1');

    expect(harness.views.has('msg-1')).toBe(false);
    expect(harness.views.has('msg-2')).toBe(true);
  });

  test('drops the views of a message that never stored a row', () => {
    const harness = createHarness();
    const storage = {} as SessionStorage;
    // A part delta can create parts before the message row.
    harness.parts.set('msg-1', [makePart('a', 'msg-1')]);
    primeViews(harness, 'msg-1');

    deleteMessageFromStorage(storage, harness.containers, 'msg-1');

    expect(harness.views.has('msg-1')).toBe(false);
  });
});

describe('clearStorage', () => {
  test('drops every cached view and snapshot', () => {
    const harness = createHarness();
    const storage = {} as SessionStorage;
    harness.messages.set('msg-1', { id: 'msg-1' });
    harness.messages.set('msg-2', { id: 'msg-2' });
    harness.messageIds = ['msg-1', 'msg-2'];
    harness.parts.set('msg-1', [makePart('a', 'msg-1')]);
    harness.parts.set('msg-2', [makePart('a', 'msg-2')]);
    primeViews(harness, 'msg-1');
    primeViews(harness, 'msg-2');

    clearStorage(storage, harness.containers);

    expect(harness.views.size).toBe(0);
    expect(harness.snapshot.size).toBe(0);
    expect(harness.parts.size).toBe(0);
    expect(harness.messages.size).toBe(0);
  });
});
