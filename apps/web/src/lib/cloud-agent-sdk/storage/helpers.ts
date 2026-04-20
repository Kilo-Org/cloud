import type { Part, TextPart } from '@/types/opencode.gen';

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

function upsertPartDroppingStaleSyntheticTextParts(arr: Part[], part: Part): Part[] {
  const nextPart = clonePart(part);
  const incomingIsSynthetic = Reflect.get(part, 'synthetic') === true;
  const shouldDropSyntheticText = !incomingIsSynthetic && part.type === 'text';
  const filtered = shouldDropSyntheticText
    ? arr.filter(
        existing =>
          existing.id === part.id ||
          existing.messageID !== part.messageID ||
          existing.type !== 'text' ||
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
  clonePart,
  createReadonlyPartView,
  createSeedTextPart,
  insertPartSorted,
  insertSorted,
  isSupportedDeltaField,
  notify,
  upsertPartDroppingStaleSyntheticTextParts,
};
