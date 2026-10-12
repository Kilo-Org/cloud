import type { ModelEvent } from '../../core/model.js';
import type { WirePart } from './wire/wire.js';

interface OpenCall {
  readonly id: string;
  name: string;
  text: string;
}

interface IndexedCalls {
  indexed: Map<string, OpenCall> | undefined;
  called: boolean;
}

type CallPart = Extract<WirePart, { readonly kind: 'callStart' | 'callArguments' | 'callEnd' }>;
const nothing: readonly ModelEvent[] = [];

const closed = (held: OpenCall | undefined): readonly ModelEvent[] =>
  held === undefined
    ? nothing
    : [{ kind: 'toolCall', call: { id: held.id, name: held.name, arguments: held.text } }];

const startIndexed = (
  tally: IndexedCalls,
  part: Extract<CallPart, { readonly kind: 'callStart' }>,
  key: string
): readonly ModelEvent[] => {
  tally.indexed ??= new Map<string, OpenCall>();
  const held = tally.indexed.get(key);
  tally.called = true;
  tally.indexed.set(key, { id: part.id, name: part.name, text: part.text ?? '' });
  return closed(held);
};

const endIndexed = (
  tally: IndexedCalls,
  part: Extract<CallPart, { readonly kind: 'callEnd' }>,
  key: string
): readonly ModelEvent[] => {
  const held = tally.indexed?.get(key);
  if (held !== undefined && held.text.length === 0 && part.emptyArguments !== undefined) {
    held.text = part.emptyArguments;
  }
  tally.indexed?.delete(key);
  return closed(held);
};

const indexedCall = (tally: IndexedCalls, part: CallPart, key: string): readonly ModelEvent[] => {
  switch (part.kind) {
    case 'callStart': {
      return startIndexed(tally, part, key);
    }
    case 'callArguments': {
      const held = tally.indexed?.get(key);
      if (held !== undefined) {
        held.text += part.text;
        held.name += part.name ?? '';
      }
      return nothing;
    }
    case 'callEnd': {
      return endIndexed(tally, part, key);
    }
  }
};

export type { OpenCall };
export { closed, indexedCall };
