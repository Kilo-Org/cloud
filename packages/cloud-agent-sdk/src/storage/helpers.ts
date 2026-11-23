import type { Part, TextPart } from '@kilocode/app-shared/opencode';
import type { ReadonlyPart } from '../types';
import { partSettledAt } from '../part-utils';
import { isPreviewOfStoredTool } from '../tool-detail-marker';
import type { SessionSubscriptionKey } from './types';

function messageIdKey(value: string): string {
  return value;
}

const partIdKey = (part: Part): string => part.id;

/**
 * Insert `item` before the first element whose sort key is not less than the
 * item's key, so equal keys keep their arriving order. Returns a new array and
 * leaves `arr` untouched.
 */
function insertSortedBy<T>(arr: readonly T[], item: T, key: (value: T) => string): T[] {
  const result = [...arr];
  let low = 0;
  let high = result.length;
  const itemKey = key(item);
  while (low < high) {
    const mid = (low + high) >>> 1;
    const midValue = result[mid];
    if (midValue !== undefined && key(midValue) < itemKey) low = mid + 1;
    else high = mid;
  }
  result.splice(low, 0, item);
  return result;
}

/**
 * Ordering evidence of the last accepted update for a stored part: the event
 * time it was accepted on (or the settle time that ordered it), keyed by the
 * message id the backend buckets the part under and the part id.
 *
 * The backend owns this store next to its parts. Keeping the evidence off the
 * part matters: a part is plain data the UI renders and `structuredClone`
 * copies, so a symbol-keyed property would be dropped by `clonePart` and
 * `Object.defineProperty` would throw on a non-extensible part. It is keyed by
 * the part's own id rather than by the part object, because object identity is
 * not stable across a clone either.
 */
type PartOrderingEvidence = Map<string, number>;

/** Per-message cached part views: the views, an invalidation marker, or nothing. */
type PartsSnapshot = Map<string, readonly ReadonlyPart[] | null>;

/**
 * Immutable views of the stored parts of one backend, keyed by message and
 * then by part id, so a rebuild only visits the parts of the message it is
 * rebuilding.
 *
 * A view wraps a clone of the part it was built from, so it may be reused only
 * while the part now stored is the very object the view was built from. Every
 * storage path replaces a part object instead of mutating it (`applyTextDeltas`
 * returns a new object and `upsertPart` stores a clone), so a replaced part
 * always misses this cache and is rebuilt, and a reused view can never show
 * content the store has already moved past.
 */
type PartViewCache = Map<string, Map<string, { source: Part; view: ReadonlyPart }>>;

function createPartViewCache(): PartViewCache {
  return new Map<string, Map<string, { source: Part; view: ReadonlyPart }>>();
}

/**
 * Key of one part's ordering evidence. The message id is the one the storage
 * keeps the parts under, not the label the part object carries, so the insert,
 * the stale check and `forgetPartUpdateTime` all address the same entry.
 */
function partOrderingKey(messageId: string, partId: string): string {
  return `${messageId}\u0000${partId}`;
}

/**
 * Record the event time of an accepted update under the bucket the part is
 * stored in.
 */
function rememberPartUpdateTime(
  evidence: PartOrderingEvidence,
  messageId: string,
  partId: string,
  eventTime: number | undefined
): void {
  if (eventTime === undefined) return;
  evidence.set(partOrderingKey(messageId, partId), eventTime);
}

function storedPartUpdateTime(
  evidence: PartOrderingEvidence,
  messageId: string,
  partId: string
): number | undefined {
  return evidence.get(partOrderingKey(messageId, partId));
}

/**
 * Drop the ordering evidence of a part the backend no longer keeps. It takes
 * the same message id the upsert keyed the evidence with, so the delete always
 * finds the entry.
 */
function forgetPartUpdateTime(
  evidence: PartOrderingEvidence,
  messageId: string,
  partId: string
): void {
  evidence.delete(partOrderingKey(messageId, partId));
}

function toolLifecycleRank(part: Part): number | null {
  if (part.type !== 'tool') return null;
  switch (part.state.status) {
    case 'pending':
      return 0;
    case 'running':
      return 1;
    case 'completed':
    case 'error':
      return 2;
    default:
      return null;
  }
}

/**
 * Start time a running tool part carries as its ordering evidence. A running
 * part is a live run in progress, so `state.time.start` says when that run
 * began — the only ordering evidence an unsettled part has. A stored running
 * part that was replayed from a snapshot carries no recorded update time, so
 * without this a terminal replay could be ordered against nothing.
 *
 * `state.time` is read defensively: an ingest-compacted part keeps only
 * `state.status`, so a replayed running part can carry no start time and then
 * has no ordering evidence.
 */
function toolRunningStartedAt(part: Part): number | undefined {
  if (part.type !== 'tool') return undefined;
  const state = part.state;
  if (state.status === 'running') return state.time?.start;
  return undefined;
}

/** Ordering evidence of a terminal update: its event time, else its settle time. */
function terminalOrder(part: Part, eventTime: number | undefined): number | undefined {
  return eventTime ?? partSettledAt(part);
}

/**
 * Ordering evidence of a stored running part: the later of the event time the
 * update that applied it carried and the run's `time.start`.
 */
function runningOrder(stored: Part, storedEventTime: number | undefined): number | undefined {
  const startedAt = toolRunningStartedAt(stored);
  if (storedEventTime === undefined || startedAt === undefined) {
    return storedEventTime ?? startedAt;
  }
  return Math.max(storedEventTime, startedAt);
}

/** A terminal update over a stored terminal applies only when it postdates it. */
function terminalBeatsTerminal(
  stored: Part,
  incoming: Part,
  storedEventTime: number | undefined,
  eventTime: number | undefined
): boolean {
  const incomingOrder = terminalOrder(incoming, eventTime);
  const storedOrder = terminalOrder(stored, storedEventTime);
  if (incomingOrder === undefined || storedOrder === undefined) return false;
  return incomingOrder > storedOrder;
}

/** A terminal update over a stored running part applies only when it postdates both evidence pieces. */
function terminalBeatsRunning(
  stored: Part,
  incoming: Part,
  storedEventTime: number | undefined,
  eventTime: number | undefined
): boolean {
  const incomingOrder = terminalOrder(incoming, eventTime);
  if (incomingOrder === undefined) return false;
  // The stored running part carries two pieces of evidence: the event time of
  // the update that last applied it (which can be inherited from an older part
  // replaced on the same id) and the run's own `time.start`. A terminal must
  // postdate both, so bound the guard by the later one — inherited older
  // evidence must not drop it below the live run.
  const storedOrder = runningOrder(stored, storedEventTime);
  return storedOrder === undefined || incomingOrder > storedOrder;
}

/** A running update over a stored terminal applies only when the run started after its settle time. */
function runningReopensTerminal(stored: Part, incoming: Part): boolean {
  const runningStartedAt = toolRunningStartedAt(incoming);
  const storedSettledAt = partSettledAt(stored);
  return (
    runningStartedAt !== undefined &&
    storedSettledAt !== undefined &&
    runningStartedAt > storedSettledAt
  );
}

/**
 * A tool part advances pending → running → terminal and never moves backwards.
 * A snapshot, history or DO replay can re-deliver an older part version over
 * newer live state, so a lower-ranked update is dropped (unless it reopens a
 * settled run — see `runningReopensTerminal`), and a terminal update is applied
 * only when it carries ordering evidence that it postdates the stored update
 * (the event's own time, or the tool state's `time.end` when a replay carries
 * no event time). A terminal with no evidence at all never replaces a live
 * running task.
 */
function isStaleToolLifecycleUpdate(
  stored: Part,
  incoming: Part,
  storedEventTime: number | undefined,
  eventTime: number | undefined
): boolean {
  const storedRank = toolLifecycleRank(stored);
  const incomingRank = toolLifecycleRank(incoming);
  if (storedRank === null || incomingRank === null) return false;

  if (storedEventTime !== undefined && eventTime !== undefined && eventTime < storedEventTime) {
    return true;
  }

  if (incomingRank < storedRank) {
    // Running (1) over terminal (2): the run reopens the settled run only when
    // its start postdates the settle time. Every other lower-ranked update is
    // stale.
    if (incomingRank === 1 && storedRank === 2) {
      return !runningReopensTerminal(stored, incoming);
    }
    return true;
  }

  if (incomingRank === 2 && storedRank === 2) {
    return !terminalBeatsTerminal(stored, incoming, storedEventTime, eventTime);
  }

  if (incomingRank === 2 && storedRank === 1) {
    return !terminalBeatsRunning(stored, incoming, storedEventTime, eventTime);
  }

  return false;
}

function upsertPartDroppingStaleSyntheticParts(
  messageId: string,
  arr: Part[],
  part: Part,
  eventTime: number | undefined,
  evidence: PartOrderingEvidence,
  authoritative = false
): Part[] {
  const incomingIsSynthetic = Reflect.get(part, 'synthetic') === true;
  // A non-synthetic text or file part drops the synthetic placeholder parts of
  // the same type on its message: the optimistic text row and the optimistic
  // file placeholders both reconcile to one authoritative part set.
  const shouldDropSynthetic =
    !incomingIsSynthetic && (part.type === 'text' || part.type === 'file');
  const filtered = shouldDropSynthetic
    ? arr.filter(
        existing =>
          existing.id === part.id ||
          existing.messageID !== messageId ||
          existing.type !== part.type ||
          Reflect.get(existing, 'synthetic') !== true
      )
    : arr;
  const idx = filtered.findIndex(p => p.id === part.id);

  if (idx >= 0) {
    const existing = filtered[idx];
    const storedEventTime =
      existing === undefined ? undefined : storedPartUpdateTime(evidence, messageId, existing.id);
    if (
      existing !== undefined &&
      !authoritative &&
      isStaleToolLifecycleUpdate(existing, part, storedEventTime, eventTime)
    ) {
      return arr;
    }
    // A later history page or replay may carry a bounded preview of a tool call
    // this storage already holds in full; keep the complete copy.
    if (existing !== undefined && isPreviewOfStoredTool(existing, part)) return arr;
    // The rejection paths above drop the incoming part, so they must not pay
    // for a copy of it.
    const nextPart = clonePart(part);
    const nextArr = [...filtered];
    nextArr[idx] = nextPart;
    // Remember the ordering evidence the accepted update actually won on: its
    // own event time, else the settle time that ordered it here. Dropping that
    // evidence for an older recorded event time would let a later out-of-order
    // terminal whose event time falls between the two win.
    rememberPartUpdateTime(
      evidence,
      messageId,
      nextPart.id,
      eventTime ?? partSettledAt(nextPart) ?? storedEventTime
    );
    return nextArr;
  }

  const nextPart = clonePart(part);
  rememberPartUpdateTime(evidence, messageId, nextPart.id, eventTime);
  return insertSortedBy(filtered, nextPart, partIdKey);
}

const SUPPORTED_DELTA_FIELDS = new Set(['text']);

function isSupportedDeltaField(field: string): boolean {
  return SUPPORTED_DELTA_FIELDS.has(field);
}

function clonePart(part: Part): Part {
  return structuredClone(part);
}

function createReadonlyPartView(part: Part): ReadonlyPart {
  return new Proxy(part, {
    set() {
      return true;
    },
    deleteProperty() {
      return true;
    },
    defineProperty() {
      return true;
    },
  });
}

/**
 * Append a batch of streamed chunks to a text part with a single allocation.
 *
 * The delta path buffers every `message.part.delta` and joins the batch once
 * per publication, so the per-token cost stays O(1) (a buffer push) instead of
 * re-copying the whole accumulated text — which is O(n) per token and
 * quadratic over a long reasoning/text stream.
 */
function applyTextDeltas(part: Part, deltas: readonly string[]): Part {
  if (!('text' in part) || typeof part.text !== 'string') {
    return part;
  }
  if (deltas.length === 0) {
    return part;
  }
  const delta = deltas.length === 1 ? (deltas[0] ?? '') : deltas.join('');
  if (delta === '') {
    return part;
  }
  return { ...part, text: part.text + delta };
}

/**
 * Returns the stored array unchanged when the chunks change nothing, so a
 * caller can skip publication on a no-op.
 */
function appendPartTextChunks(
  arr: Part[] | undefined,
  messageId: string,
  partId: string,
  chunks: readonly string[]
): Part[] {
  if (!arr) {
    // First delta for this message — bootstrap a minimal text part.
    return [createSeedTextPart(messageId, partId, chunks.join(''))];
  }
  const idx = arr.findIndex(p => p.id === partId);
  const existing = idx >= 0 ? arr[idx] : undefined;
  if (!existing) {
    // Part not yet known for this message — create it with the chunks as seed.
    return insertSortedBy(arr, createSeedTextPart(messageId, partId, chunks.join('')), partIdKey);
  }
  const updatedPart = applyTextDeltas(existing, chunks);
  if (updatedPart === existing) {
    return arr;
  }
  const nextArr = [...arr];
  nextArr[idx] = updatedPart;
  return nextArr;
}

/**
 * The snapshot is dropped before the notification, so a subscriber that reads
 * `getParts` from its callback rebuilds from this change instead of the stale
 * snapshot.
 */
function publishPartsChanged(
  snapshot: PartsSnapshot,
  subscribers: SubscriberRegistry,
  messageId: string
): void {
  snapshot.set(messageId, null);
  subscribers.notifyParts(messageId);
}

/**
 * One parts read for the whole message: the cached snapshot when this message
 * already has one, `EMPTY_PARTS` when it stores nothing, else the snapshot
 * recorded for later reads, assembled from the immutable views `views` already
 * holds for the parts that did not change and fresh clone-plus-view builds for
 * the ones that did. A `null` marker (a change that dropped the snapshot) is
 * falsy, so it rebuilds.
 *
 * The cache is per message, so a rebuild costs one visit to this message's own
 * parts: a part whose stored object is still the one its cached view came from
 * is reused as is, and a streamed delta batch that replaced a single part
 * clones only that part. Entries are swept after each build to the ids the
 * message still stores, so a deleted part cannot leak its view.
 */
function readPartsSnapshot(
  messageId: string,
  arr: Part[] | undefined,
  snapshot: PartsSnapshot,
  views: PartViewCache
): readonly ReadonlyPart[] {
  const cached = snapshot.get(messageId);
  if (cached) return cached;

  if (!arr || arr.length === 0) {
    views.delete(messageId);
    return EMPTY_PARTS;
  }

  let byPart = views.get(messageId);
  if (!byPart) {
    byPart = new Map<string, { source: Part; view: ReadonlyPart }>();
    views.set(messageId, byPart);
  }

  const built = arr.map(part => {
    const entry = byPart.get(part.id);
    if (entry && entry.source === part) return entry.view;
    const view = createReadonlyPartView(clonePart(part));
    byPart.set(part.id, { source: part, view });
    return view;
  });

  if (byPart.size !== built.length) {
    const stored = new Set(built.map(part => part.id));
    for (const partId of [...byPart.keys()]) {
      if (!stored.has(partId)) byPart.delete(partId);
    }
  }

  snapshot.set(messageId, built);
  return built;
}

function createSeedTextPart(messageId: string, partId: string, text: string): TextPart {
  return {
    id: partId,
    sessionID: '',
    messageID: messageId,
    type: 'text',
    text,
  };
}

const messageIdsKey: SessionSubscriptionKey = 'messageIds';

/** Subscription key of one message row's channel. */
function messageKey(messageId: string): SessionSubscriptionKey {
  return `message:${messageId}`;
}

/** Subscription key of one message's parts channel. */
function partsKey(messageId: string): SessionSubscriptionKey {
  return `parts:${messageId}`;
}

type SubscriberRegistry = {
  subscribe(key: SessionSubscriptionKey, callback: () => void): () => void;
  notify(key: SessionSubscriptionKey): void;
  notifyMessageIds(): void;
  notifyMessage(messageId: string): void;
  notifyParts(messageId: string): void;
};

function createSubscriberRegistry(): SubscriberRegistry {
  const subscribers = new Map<string, Set<() => void>>();
  const notify = (key: SessionSubscriptionKey): void => {
    const subs = subscribers.get(key);
    if (subs) {
      for (const cb of subs) cb();
    }
  };
  return {
    subscribe(key, callback) {
      let set = subscribers.get(key);
      if (!set) {
        set = new Set();
        subscribers.set(key, set);
      }
      set.add(callback);
      return () => {
        set.delete(callback);
        if (set.size === 0) subscribers.delete(key);
      };
    },
    notify,
    notifyMessageIds() {
      notify(messageIdsKey);
    },
    notifyMessage(messageId) {
      notify(messageKey(messageId));
    },
    notifyParts(messageId) {
      notify(partsKey(messageId));
    },
  };
}

const EMPTY_PARTS: readonly Part[] = Object.freeze([]);

export {
  EMPTY_PARTS,
  appendPartTextChunks,
  applyTextDeltas,
  clonePart,
  createPartViewCache,
  createReadonlyPartView,
  createSeedTextPart,
  createSubscriberRegistry,
  forgetPartUpdateTime,
  insertSortedBy,
  isSupportedDeltaField,
  messageIdsKey,
  messageKey,
  messageIdKey,
  partsKey,
  publishPartsChanged,
  readPartsSnapshot,
  upsertPartDroppingStaleSyntheticParts,
};
export { orderMessageIds } from './message-order';
export type {
  PartOrderingEvidence,
  PartViewCache,
  PartsSnapshot,
  SessionSubscriptionKey,
  SubscriberRegistry,
};
