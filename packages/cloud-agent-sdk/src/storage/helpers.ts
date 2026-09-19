import type { Part, TextPart } from '@kilocode/app-shared/opencode';
import { partSettledAt } from '../part-utils';

function insertSorted(arr: string[], id: string): string[] {
  const result = [...arr];
  let low = 0,
    high = result.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if ((result[mid] ?? '') < id) low = mid + 1;
    else high = mid;
  }
  result.splice(low, 0, id);
  return result;
}

function insertPartSorted(arr: Part[], part: Part): Part[] {
  const result = [...arr];
  let low = 0,
    high = result.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    const midPart = result[mid];
    if (midPart !== undefined && midPart.id < part.id) low = mid + 1;
    else high = mid;
  }
  result.splice(low, 0, part);
  return result;
}

/**
 * Ordering evidence of the last accepted update for a stored part: the event
 * time it was accepted on (or the settle time that ordered it), keyed by the
 * part's message and id.
 *
 * The backend owns this store next to its parts. Keeping the evidence off the
 * part matters: a part is plain data the UI renders and `structuredClone`
 * copies, so a symbol-keyed property would be dropped by `clonePart` and
 * `Object.defineProperty` would throw on a non-extensible part. It is keyed by
 * the part's own id rather than by the part object, because object identity is
 * not stable across a clone either.
 */
type PartOrderingEvidence = Map<string, number>;

function partOrderingKey(messageID: string, partId: string): string {
  return `${messageID}\u0000${partId}`;
}

function rememberPartUpdateTime(
  evidence: PartOrderingEvidence,
  part: Part,
  eventTime: number | undefined
): void {
  if (eventTime === undefined) return;
  evidence.set(partOrderingKey(part.messageID, part.id), eventTime);
}

function storedPartUpdateTime(evidence: PartOrderingEvidence, part: Part): number | undefined {
  return evidence.get(partOrderingKey(part.messageID, part.id));
}

/** Drop the ordering evidence of a part the backend no longer keeps. */
function forgetPartUpdateTime(
  evidence: PartOrderingEvidence,
  messageID: string,
  partId: string
): void {
  evidence.delete(partOrderingKey(messageID, partId));
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

/**
 * A tool part advances pending → running → terminal and never moves backwards.
 * A snapshot, history or DO replay can re-deliver an older part version over
 * newer live state, so a lower-ranked update is dropped, and a terminal update
 * is applied only when it carries ordering evidence that it postdates the
 * stored update (the event's own time, or the tool state's `time.end` when a
 * replay carries no event time). Over a running part, that evidence must also
 * postdate the stored running update's ordering evidence — the later of its
 * recorded event time (when the update came from the wire) and the run's
 * `time.start` (the only evidence a replayed running part carries, and the bound
 * that keeps an inherited older event time from dropping the guard below the
 * live run): a terminal whose settle time predates the live run is an
 * out-of-order replay, not a completion. A terminal with no evidence at all
 * never replaces a live running task.
 *
 * The same ordering evidence settles the mirror case: a run whose `time.start`
 * postdates a stored terminal's settle time is a newer observation of that part
 * (a reopen replay of the live run over a stale cached terminal), so it
 * replaces it instead of being dropped as a backwards lifecycle step.
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
    if (incomingRank === 1 && storedRank === 2) {
      const runningStartedAt = toolRunningStartedAt(incoming);
      const storedSettledAt = partSettledAt(stored);
      if (
        runningStartedAt !== undefined &&
        storedSettledAt !== undefined &&
        runningStartedAt > storedSettledAt
      ) {
        return false;
      }
    }
    return true;
  }

  if (incomingRank === 2 && storedRank === 2) {
    const incomingOrder = eventTime ?? partSettledAt(incoming);
    const storedOrder = storedEventTime ?? partSettledAt(stored);
    if (incomingOrder === undefined || storedOrder === undefined) return true;
    return incomingOrder <= storedOrder;
  }

  if (incomingRank === 2 && storedRank === 1) {
    const incomingOrder = eventTime ?? partSettledAt(incoming);
    if (incomingOrder === undefined) return true;
    // The stored running part carries two pieces of evidence: the event time of
    // the update that last applied it (which can be inherited from an older part
    // replaced on the same id) and the run's own `time.start`. A terminal must
    // postdate both, so bound the guard by the later one — inherited older
    // evidence must not drop it below the live run.
    const runningStartedAt = toolRunningStartedAt(stored);
    const storedOrder =
      storedEventTime === undefined || runningStartedAt === undefined
        ? (storedEventTime ?? runningStartedAt)
        : Math.max(storedEventTime, runningStartedAt);
    if (storedOrder !== undefined && incomingOrder <= storedOrder) return true;
  }

  return false;
}

function upsertPartDroppingStaleSyntheticParts(
  arr: Part[],
  part: Part,
  eventTime: number | undefined,
  evidence: PartOrderingEvidence
): Part[] {
  const nextPart = clonePart(part);
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
          existing.messageID !== part.messageID ||
          existing.type !== part.type ||
          Reflect.get(existing, 'synthetic') !== true
      )
    : arr;
  const idx = filtered.findIndex(p => p.id === part.id);

  if (idx >= 0) {
    const existing = filtered[idx];
    const storedEventTime =
      existing === undefined ? undefined : storedPartUpdateTime(evidence, existing);
    if (
      existing !== undefined &&
      isStaleToolLifecycleUpdate(existing, part, storedEventTime, eventTime)
    ) {
      return arr;
    }
    const nextArr = [...filtered];
    nextArr[idx] = nextPart;
    // Remember the ordering evidence the accepted update actually won on: its
    // own event time, else the settle time that ordered it here. Dropping that
    // evidence for an older recorded event time would let a later out-of-order
    // terminal whose event time falls between the two win.
    rememberPartUpdateTime(
      evidence,
      nextPart,
      eventTime ?? partSettledAt(nextPart) ?? storedEventTime
    );
    return nextArr;
  }

  rememberPartUpdateTime(evidence, nextPart, eventTime);
  return insertPartSorted(filtered, nextPart);
}

const STRUCTURAL_PART_FIELDS = new Set(['id', 'messageID', 'sessionID', 'type']);
const SUPPORTED_DELTA_FIELDS = new Set(['text']);

function isSupportedDeltaField(field: string): boolean {
  return SUPPORTED_DELTA_FIELDS.has(field) && !STRUCTURAL_PART_FIELDS.has(field);
}

function clonePart(part: Part): Part {
  return structuredClone(part);
}

function createReadonlyPartView(part: Part): Part {
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

function applyTextDelta(part: Part, delta: string): Part {
  if (!('text' in part) || typeof part.text !== 'string') {
    return part;
  }
  return { ...part, text: part.text + delta };
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

function createSeedTextPart(messageId: string, partId: string, text: string): TextPart {
  return {
    id: partId,
    sessionID: '',
    messageID: messageId,
    type: 'text',
    text,
  };
}

function notify(subscribers: Map<string, Set<() => void>>, key: string): void {
  const subs = subscribers.get(key);
  if (subs) {
    for (const cb of subs) cb();
  }
}

const EMPTY_PARTS: readonly Part[] = Object.freeze([]);

export {
  EMPTY_PARTS,
  applyTextDelta,
  applyTextDeltas,
  clonePart,
  createReadonlyPartView,
  createSeedTextPart,
  forgetPartUpdateTime,
  insertPartSorted,
  insertSorted,
  isSupportedDeltaField,
  notify,
  upsertPartDroppingStaleSyntheticParts,
};
export type { PartOrderingEvidence };
