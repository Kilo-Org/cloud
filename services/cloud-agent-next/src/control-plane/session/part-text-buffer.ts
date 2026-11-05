import type { z } from 'zod';
import type { kilo2ConversationMessageSchema } from '@kilocode/session-ingest-contracts';
import { slimPersistedKilocodeEvent } from '../../shared/ingest-frame.js';
import type { SessionEventQueries } from './event-queries.js';

/** The longest time streamed text stays newer than its stored row. */
export const PART_TEXT_FLUSH_MS = 1000;

type BufferedRow = { rowId: number; sessionId: string; timestamp: number };

/** A v1 part row (`part/...`) whose text grows by deltas. */
export type BufferedPartText = BufferedRow & {
  kind: 'part';
  part: Record<string, unknown>;
  text: string;
};

/** A kilo2 message row (`message/...`) whose content grows by deltas. */
export type BufferedMessageText = BufferedRow & {
  kind: 'message';
  properties: z.infer<typeof kilo2ConversationMessageSchema>;
};

type Buffered = BufferedPartText | BufferedMessageText;

function storedEvent(buffered: Buffered) {
  if (buffered.kind === 'part') {
    const event = 'message.part.updated';
    return {
      type: event,
      event,
      properties: { part: { ...buffered.part, text: buffered.text } },
    };
  }
  const event = 'conversation.message.updated';
  return { type: event, event, properties: buffered.properties };
}

/**
 * Streamed text that is newer than its stored row.
 *
 * Each live delta still takes its own mutation cursor, but it does not rewrite
 * the full row. The owner flushes before any other event that reads or writes
 * a row, and before a read of stored history; a timer flushes the rest. A
 * restart can lose the text since the last flush; the final full update
 * (`message.part.updated` or `conversation.message.updated`) carries it again.
 * A row that fails to write is reported and dropped in the same way, so it
 * cannot block other rows or grow without bound.
 */
export function createPartTextBuffer(input: {
  queries: Pick<SessionEventQueries, 'upsert'>;
  onFlushError: (error: unknown) => void;
}) {
  const rows = new Map<string, Buffered>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  function arm(): void {
    timer ??= setTimeout(flush, PART_TEXT_FLUSH_MS);
  }

  function flush(): void {
    clearTimeout(timer);
    timer = undefined;
    for (const [entityId, buffered] of rows) {
      rows.delete(entityId);
      try {
        input.queries.upsert({
          executionId: '',
          sessionId: buffered.sessionId,
          streamEventType: 'kilocode',
          payload: JSON.stringify(slimPersistedKilocodeEvent(storedEvent(buffered))),
          timestamp: buffered.timestamp,
          entityId,
        });
      } catch (error) {
        input.onFlushError(error);
      }
    }
  }

  return {
    get<K extends Buffered['kind']>(
      entityId: string,
      kind: K
    ): Extract<Buffered, { kind: K }> | undefined {
      const buffered = rows.get(entityId);
      return buffered?.kind === kind ? (buffered as Extract<Buffered, { kind: K }>) : undefined;
    },
    /** Entries are replaced, never changed, so `transaction` can restore them. */
    set(entityId: string, buffered: Buffered): void {
      rows.set(entityId, buffered);
      arm();
    },
    flush,
    /**
     * Runs a SQL transaction that can buffer or flush text. If it throws, its
     * rows and cursors roll back, so the buffer returns to its earlier state too.
     */
    transaction<T>(write: () => T): T {
      const before = new Map(rows);
      try {
        return write();
      } catch (error) {
        rows.clear();
        for (const [entityId, buffered] of before) rows.set(entityId, buffered);
        if (rows.size > 0) arm();
        throw error;
      }
    },
    clear(): void {
      clearTimeout(timer);
      timer = undefined;
      rows.clear();
    },
  };
}

export type PartTextBuffer = ReturnType<typeof createPartTextBuffer>;
