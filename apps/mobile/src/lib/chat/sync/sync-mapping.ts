import type { PortableMessage, PulledMessage } from '@kilocode/cloud-agent-sdk';
import type { Turn } from '@kilocode/harness-sdk';

import { idleMsgIdForTurn, importedPartId, importedTurnId, msgIdForTurn, ulidTimeMs } from './sync-ids';

/**
 * Harness turns to portable messages, and pulled messages back to harness
 * turns. Pure: blob uploads and seq assignment belong to the engine, which
 * hands this module finished blob references and one seq per message.
 *
 * The one structural translation is tool results. The harness keeps a
 * result in its own following `user` turn; the portable log folds it into
 * the assistant tool content it answers, joined by `callId`. A user turn
 * made only of results therefore produces no portable message, and an
 * imported tool produces a call part plus a following results turn.
 */

type Part = Turn['parts'][number];

/** A blob the engine already uploaded for one image part. */
export type UploadedBlob = { readonly hash: string; readonly bytes: number };

/** The model a portable assistant message records. */
export type PortableModelRef = {
  readonly providerID: string;
  readonly id: string;
  readonly variant?: string;
};

/**
 * How a mobile model target reads on the wire. Gateway models keep their id
 * under the `kilo` provider; on-device and custom-backend models record
 * providers nothing else can route, so the other side falls back to its own
 * default instead of failing on an unknown provider.
 */
export function portableModelRef(target: string): PortableModelRef {
  if (target.startsWith('gguf:') || target.startsWith('local:') || target.startsWith('local/')) {
    return { providerID: 'kilo-mobile-local', id: target };
  }
  if (target.startsWith('backend:') || target.startsWith('custom:')) {
    return { providerID: 'kilo-mobile-custom', id: target };
  }
  return { providerID: 'kilo', id: target };
}

/** Every image part in these turns, which the engine uploads before mapping. */
export function imagePartsOf(
  turns: readonly Turn[]
): readonly { readonly partId: string; readonly media: string; readonly base64: string }[] {
  const images: { partId: string; media: string; base64: string }[] = [];
  for (const turn of turns) {
    for (const part of turn.parts) {
      if (part.kind === 'image') {
        images.push({ partId: part.id, media: part.media, base64: part.body });
      }
    }
  }
  return images;
}

function toolResultsByCallId(turns: readonly Turn[]): ReadonlyMap<string, Part> {
  const results = new Map<string, Part>();
  for (const turn of turns) {
    for (const part of turn.parts) {
      if (part.kind === 'toolResult') {
        results.set(part.callId, part);
      }
    }
  }
  return results;
}

function toolInput(body: string): Record<string, unknown> | string {
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : body;
  } catch {
    return body;
  }
}

/** One turn with the seq and message id the engine assigned it. */
export type SequencedTurn = {
  readonly turn: Turn;
  readonly seq: number;
  readonly msgId: string;
};

/**
 * Portable messages for sequenced turns, in turn order. An idle marker
 * settles the batch when its last message is an assistant one, so the tail
 * the other side pulls reads as finished rather than mid-turn.
 */
export function turnsToPortable(
  sequenced: readonly SequencedTurn[],
  options: {
    readonly model: PortableModelRef;
    readonly agent: string;
    readonly blobs: ReadonlyMap<string, UploadedBlob>;
    readonly idleSeq: number | null;
    readonly now: number;
  }
): PortableMessage[] {
  const results = toolResultsByCallId(sequenced.map(one => one.turn));
  const messages: PortableMessage[] = [];
  for (const { turn, seq, msgId } of sequenced) {
    const created = ulidTimeMs(turn.id) ?? options.now;
    if (turn.role === 'user') {
      const text = turn.parts
        .filter(part => part.kind === 'text' || part.kind === 'summary')
        .map(part => part.body)
        .join('');
      const files = turn.parts.flatMap(part => {
        if (part.kind !== 'image') {
          return [];
        }
        const blob = options.blobs.get(part.id);
        return blob === undefined ? [] : [{ mime: part.media, blob }];
      });
      if (text === '' && files.length === 0) {
        continue;
      }
      messages.push({ type: 'user', id: msgId, seq, text, files, time: { created } });
      continue;
    }
    const content: Extract<PortableMessage, { type: 'assistant' }>['content'] = [];
    for (const part of turn.parts) {
      if (part.kind === 'text' || part.kind === 'summary') {
        content.push({ type: 'text', text: part.body });
      } else if (part.kind === 'reasoning') {
        content.push({ type: 'reasoning', text: part.body });
      } else if (part.kind === 'toolCall') {
        const result = results.get(part.callId);
        content.push({
          type: 'tool',
          id: part.callId,
          name: part.name,
          state: {
            status: result?.kind === 'toolResult' && result.failed ? 'error' : 'completed',
            input: toolInput(part.body),
            content:
              result?.kind === 'toolResult' ? [{ type: 'text', text: result.body }] : [],
          },
        });
      }
    }
    messages.push({
      type: 'assistant',
      id: msgId,
      seq,
      agent: options.agent,
      model: options.model,
      content,
      time: { created, completed: created },
    });
  }
  const last = sequenced[sequenced.length - 1];
  if (options.idleSeq !== null && last !== undefined && last.turn.role === 'assistant') {
    messages.push({
      type: 'idle',
      id: idleMsgIdForTurn(last.turn.id),
      seq: options.idleSeq,
      outcome: 'succeeded',
      time: { created: ulidTimeMs(last.turn.id) ?? options.now },
    });
  }
  return messages;
}

/** The harness turns one pulled log makes, in seq order. Idle markers settle a tail and hold no words. */
export function pulledToTurns(pulled: readonly PulledMessage[], sessionId: string): Turn[] {
  const ordered = [...pulled].sort((one, other) => one.seq - other.seq);
  const turns: Turn[] = [];
  for (const { message, seq } of ordered) {
    const created = message.time.created;
    const turnId = importedTurnId(created, seq);
    const partId = (ordinal: number) => importedPartId(created, seq, ordinal);
    if (message.type === 'user') {
      const parts: Part[] = [];
      let ordinal = 0;
      if (message.text !== undefined && message.text !== '') {
        parts.push({ id: partId(ordinal), kind: 'text', body: message.text });
        ordinal += 1;
      }
      for (const file of message.files ?? []) {
        if ('data' in file && typeof file.data === 'string' && file.mime.startsWith('image/')) {
          parts.push({ id: partId(ordinal), kind: 'image', body: file.data, media: file.mime });
          ordinal += 1;
        }
      }
      for (const block of message.content ?? []) {
        if (block.type === 'text' && block.text !== undefined && block.text !== '') {
          parts.push({ id: partId(ordinal), kind: 'text', body: block.text });
          ordinal += 1;
        }
      }
      if (parts.length > 0) {
        turns.push({ id: turnId, sessionId, role: 'user', parts });
      }
      continue;
    }
    if (message.type !== 'assistant') {
      continue;
    }
    const parts: Part[] = [];
    const results: Part[] = [];
    let ordinal = 0;
    for (const block of message.content ?? []) {
      if (block.type === 'text' && block.text !== undefined) {
        parts.push({ id: partId(ordinal), kind: 'text', body: block.text });
        ordinal += 1;
      } else if (block.type === 'reasoning' && block.text !== undefined) {
        parts.push({ id: partId(ordinal), kind: 'reasoning', body: block.text });
        ordinal += 1;
      } else if (block.type === 'tool' && block.id !== undefined && block.name !== undefined) {
        const input = block.state?.input;
        parts.push({
          id: partId(ordinal),
          kind: 'toolCall',
          body: typeof input === 'string' ? input : JSON.stringify(input ?? {}),
          callId: block.id,
          name: block.name,
        });
        ordinal += 1;
        const text = (block.state?.content ?? [])
          .map(one => ('text' in one && typeof one.text === 'string' ? one.text : ''))
          .join('');
        results.push({
          id: partId(ordinal),
          kind: 'toolResult',
          body: text,
          callId: block.id,
          failed: block.state?.status === 'error',
        });
        ordinal += 1;
      }
    }
    if (parts.length > 0) {
      turns.push({ id: turnId, sessionId, role: 'assistant', parts });
    }
    if (results.length > 0) {
      turns.push({
        id: importedTurnId(created, seq) + 'R',
        sessionId,
        role: 'user',
        parts: results,
      });
    }
  }
  return turns;
}

/** Whether the pulled tail is settled enough to start a turn on (H6). */
export type TailState =
  | { readonly kind: 'settled' }
  | { readonly kind: 'busy' }
  | { readonly kind: 'empty' };

const STALE_TAIL_MS = 10 * 60 * 1000;

export function tailStateOf(pulled: readonly PulledMessage[], now: number): TailState {
  if (pulled.length === 0) {
    return { kind: 'empty' };
  }
  const last = [...pulled].sort((one, other) => one.seq - other.seq)[pulled.length - 1];
  if (last === undefined) {
    return { kind: 'empty' };
  }
  if (last.message.type === 'idle' || last.message.type === 'user') {
    return { kind: 'settled' };
  }
  if (last.message.type === 'assistant') {
    const completed = last.message.time.completed;
    if (completed !== undefined) {
      return { kind: 'settled' };
    }
    return now - last.message.time.created > STALE_TAIL_MS
      ? { kind: 'settled' }
      : { kind: 'busy' };
  }
  return { kind: 'settled' };
}

export { msgIdForTurn };
