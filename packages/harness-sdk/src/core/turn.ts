import { Effect } from 'effect';
import type { EntropySourceService } from './entropy.js';
import { makeId } from './id.js';

/**
 * One piece of a turn. A turn is a list of these, in the order they arrived.
 *
 * Every kind carries exactly one payload, so `body` is the only field that
 * holds content and a part is one flat row. An image keeps its bytes as base64
 * rather than as a blob: base64 is what every gateway shape wants on the wire,
 * so storing it that way costs a third more space and saves encoding the image
 * again on every single request.
 */
type TurnPart =
  | { readonly id: string; readonly kind: 'text'; readonly body: string }
  /** Everything before it, in one part. See `sinceSummary`. */
  | { readonly id: string; readonly kind: 'summary'; readonly body: string }
  | {
      readonly id: string;
      readonly kind: 'reasoning';
      readonly body: string;
      /**
       * What the provider issued with the thinking, and reads back to know the
       * thinking is its own. It is opaque: nothing here parses it or builds
       * one. A reasoning part without it cannot be replayed, so the shape that
       * renders the prompt leaves it out.
       */
      readonly signature?: string;
    }
  | {
      readonly id: string;
      readonly kind: 'image';
      readonly body: string;
      /** The media type, such as `image/png`. */
      readonly media: string;
    };

/** A part before it has an identifier. */
type PartDraft =
  | { readonly kind: 'text'; readonly body: string }
  | { readonly kind: 'summary'; readonly body: string }
  | { readonly kind: 'reasoning'; readonly body: string; readonly signature?: string }
  | { readonly kind: 'image'; readonly body: string; readonly media: string };

/**
 * One turn of a conversation. Both identifiers are monotonic ULIDs, so each is
 * both the primary key and the sort order; a separate timestamp column would
 * repeat what the identifier already holds.
 */
interface Turn {
  readonly id: string;
  readonly sessionId: string;
  readonly role: TurnRole;
  readonly parts: readonly TurnPart[];
}

type TurnRole = 'user' | 'assistant';

const turnPrefix = 'trn';
const partPrefix = 'prt';

/** What a turn is made of, before it has an identifier. */
interface TurnDraft {
  readonly sessionId: string;
  readonly role: TurnRole;
  readonly parts: readonly PartDraft[];
}

const makePart = (entropy: EntropySourceService, draft: PartDraft): Effect.Effect<TurnPart> =>
  Effect.map(makeId(entropy, partPrefix), id => ({ id, ...draft }));

const makeTurn = (entropy: EntropySourceService, draft: TurnDraft): Effect.Effect<Turn> =>
  Effect.all({
    id: makeId(entropy, turnPrefix),
    parts: Effect.forEach(draft.parts, part => makePart(entropy, part)),
  }).pipe(
    Effect.map(({ id, parts }) => ({ id, sessionId: draft.sessionId, role: draft.role, parts }))
  );

/** The plain text of a turn, which is what a caller who sends no image writes. */
const textOf = (turn: Turn): string =>
  turn.parts
    .filter(part => part.kind === 'text')
    .map(part => part.body)
    .join('');

/** A part without its identifier, so a copy of it becomes a part of its own. */
const draftOf = (part: TurnPart): PartDraft => {
  switch (part.kind) {
    case 'image': {
      return { kind: 'image', body: part.body, media: part.media };
    }
    case 'reasoning': {
      return {
        kind: 'reasoning',
        body: part.body,
        ...(part.signature === undefined ? {} : { signature: part.signature }),
      };
    }
    case 'summary': {
      return { kind: 'summary', body: part.body };
    }
    case 'text': {
      return { kind: 'text', body: part.body };
    }
  }
};

/** What a caller means by a bare string: one turn of one text part. */
const partsOf = (input: string | readonly PartDraft[]): readonly PartDraft[] =>
  typeof input === 'string' ? [{ kind: 'text', body: input }] : input;

export type { PartDraft, Turn, TurnDraft, TurnPart, TurnRole };
export { draftOf, makePart, makeTurn, partsOf, textOf };
