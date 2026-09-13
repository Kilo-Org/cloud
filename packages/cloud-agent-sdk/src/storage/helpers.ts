import type { Part, TextPart } from '@kilocode/app-shared/opencode';

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

function upsertPartDroppingStaleSyntheticParts(arr: Part[], part: Part): Part[] {
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
    const nextArr = [...filtered];
    nextArr[idx] = nextPart;
    return nextArr;
  }

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
  insertPartSorted,
  insertSorted,
  isSupportedDeltaField,
  notify,
  upsertPartDroppingStaleSyntheticParts,
};
