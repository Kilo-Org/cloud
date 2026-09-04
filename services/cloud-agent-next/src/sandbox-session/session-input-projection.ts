import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { PendingInteractions } from './sandbox-control-event.js';
import type { StoredEvent } from '../websocket/types.js';

const requestsSchema = z.array(z.object({ id: z.string().min(1) }).passthrough());
type Inputs = Pick<PendingInteractions, 'questions' | 'permissions'>;

export function pendingInputProjection(
  sessionId: string,
  before: Inputs | undefined,
  after: Inputs,
  timestamp: number
): StoredEvent[] {
  const projected: StoredEvent[] = [];
  const emit = (type: string, properties: Record<string, unknown>) => {
    projected.push({
      id: 0,
      execution_id: '',
      session_id: sessionId,
      stream_event_type: 'kilocode',
      payload: JSON.stringify({ type, event: type, properties }),
      timestamp,
    });
  };
  for (const [collection, kind] of [
    ['questions', 'question'],
    ['permissions', 'permission'],
  ] as const) {
    const next = requestsSchema.safeParse(after[collection]);
    if (!next.success) continue;
    const previous = requestsSchema.safeParse(before?.[collection] ?? []);
    const old = new Map(
      (previous.success ? previous.data : []).map(request => [request.id, request])
    );
    const current = new Map(next.data.map(request => [request.id, request]));
    for (const requestID of old.keys()) {
      if (!current.has(requestID)) emit(`${kind}.replied`, { requestID });
    }
    for (const [id, request] of current) {
      if (!isDeepStrictEqual(old.get(id), request)) emit(`${kind}.asked`, request);
    }
  }
  return projected;
}
