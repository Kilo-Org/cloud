import { z } from 'zod';
import {
  kilo2ConversationMessageSchema,
  sessionLivePlan,
  sessionLiveSummarySchema,
  sessionLiveToolStep,
  type Kilo2Message,
  type PublishCloudAgentSessionStatusParams,
  type SessionLiveFailureKind,
  type SessionLiveSummary,
} from '@kilocode/session-ingest-contracts';
import { webUrlHost } from '@kilocode/worker-utils';
import { logger } from '../../logger.js';

const NATIVE_LIVE_SUMMARY_KEY = 'native_live_summary';

/**
 * The session card summary of a Kilo v2 root, folded from its stored native messages. Kilo v2 has
 * no session-ingest client, so the Session DO derives what that client derives for Kilo v1 and
 * publishes it with the list status. `turn` is the root user message that opened the current
 * turn: a new one clears the step, plan and failure of the turn before it. Kilo v2 reports no
 * session diff, so `changes` stays null.
 */
const nativeLiveSummaryStateSchema = z.object({
  turn: z.string().nullable(),
  summary: sessionLiveSummarySchema,
});
export type NativeLiveSummaryState = z.infer<typeof nativeLiveSummaryStateSchema>;

export const EMPTY_NATIVE_LIVE_SUMMARY_STATE: NativeLiveSummaryState = {
  turn: null,
  summary: { step: null, plan: null, changes: null, failure: null },
};

const nativeStatusSchema = z.object({
  sessionID: z.string(),
  status: z.object({ type: z.string() }),
});

/** The failure kind of a native assistant error, by its type family. */
function nativeFailureKind(type: string): SessionLiveFailureKind {
  if (type === 'aborted') return 'cancelled';
  if (type.startsWith('provider')) return 'provider';
  if (type.startsWith('tool')) return 'tool';
  return 'other';
}

/**
 * Fold one native message into the running state. A native message carries its whole content on
 * every update, so a fold is idempotent: the last started tool sets the step, an unfinished
 * reasoning item at the end of the content means the model is thinking, the last `todowrite`
 * sets the plan, and the failure is the error of the latest assistant message. Kilo v2 tool names
 * map to the Kilo v1 ones the step table knows (`shell` runs like `bash`).
 */
export function foldNativeLiveSummary(
  state: NativeLiveSummaryState,
  message: Kilo2Message
): NativeLiveSummaryState {
  if (message.type === 'user') {
    return message.id === state.turn
      ? state
      : { turn: message.id, summary: EMPTY_NATIVE_LIVE_SUMMARY_STATE.summary };
  }
  if (message.type !== 'assistant') return state;
  let { step, plan } = state.summary;
  const content = message.content ?? [];
  for (const [index, item] of content.entries()) {
    if (item.type === 'tool' && item.name !== undefined && item.state !== undefined) {
      const name = item.name === 'shell' ? 'bash' : item.name;
      const input = typeof item.state.input === 'string' ? {} : item.state.input;
      if (name.toLowerCase() === 'todowrite') plan = sessionLivePlan(input);
      if (item.state.status === 'streaming' || item.state.status === 'running')
        step = sessionLiveToolStep(name, input, webUrlHost);
    } else if (
      item.type === 'reasoning' &&
      item.time?.completed === undefined &&
      index === content.length - 1
    ) {
      step = { verb: 'thinking', target: null };
    }
  }
  return {
    turn: state.turn,
    summary: {
      step,
      plan,
      changes: null,
      failure: message.error === undefined ? null : { kind: nativeFailureKind(message.error.type) },
    },
  };
}

export function createNativeLiveSummary(storage: Pick<DurableObjectStorage, 'kv'>) {
  const current = (): NativeLiveSummaryState | undefined => {
    const raw = storage.kv.get<unknown>(NATIVE_LIVE_SUMMARY_KEY);
    if (raw === undefined) return undefined;
    const parsed = nativeLiveSummaryStateSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
    storage.kv.delete(NATIVE_LIVE_SUMMARY_KEY);
    logger.warn('Discarded invalid native live summary; the next native message rebuilds it');
    return undefined;
  };

  return {
    /**
     * The root's summary for a list status snapshot, or undefined when the root has no native
     * transcript (Kilo v1). An idle or failed snapshot shows no step or plan without clearing
     * them in storage: only the root's own events change the stored summary.
     */
    settled(
      status: PublishCloudAgentSessionStatusParams['status']
    ): SessionLiveSummary | undefined {
      const state = current();
      if (state === undefined) return undefined;
      return status === 'idle' || status === 'failed'
        ? { ...state.summary, step: null, plan: null }
        : state.summary;
    },
    /**
     * Fold a stored event of the root. Runs in the transaction that stores the event, so the
     * summary never misses or repeats a committed row. A `conversation.message.updated` updates
     * the summary. An idle `session.status` ends the turn: it clears the step and plan, as the
     * Kilo v1 idle transition does, so a turn that opens without a root user message (a
     * background command's completion) does not start with the last turn's step. The failure
     * stays until a new turn starts.
     */
    observe(
      event: { type: string; properties: Record<string, unknown> },
      rootKiloSessionId: string
    ): void {
      if (event.type === 'session.status') {
        const parsed = nativeStatusSchema.safeParse(event.properties);
        if (
          !parsed.success ||
          parsed.data.sessionID !== rootKiloSessionId ||
          parsed.data.status.type !== 'idle'
        )
          return;
        const state = current();
        if (state === undefined || (state.summary.step === null && state.summary.plan === null))
          return;
        storage.kv.put(NATIVE_LIVE_SUMMARY_KEY, {
          turn: state.turn,
          summary: { ...state.summary, step: null, plan: null },
        });
        return;
      }
      if (event.type !== 'conversation.message.updated') return;
      const parsed = kilo2ConversationMessageSchema.safeParse(event.properties);
      if (!parsed.success || parsed.data.sessionID !== rootKiloSessionId) return;
      const previous = current();
      const next = foldNativeLiveSummary(
        previous ?? EMPTY_NATIVE_LIVE_SUMMARY_STATE,
        parsed.data.message
      );
      if (previous === undefined || JSON.stringify(previous) !== JSON.stringify(next))
        storage.kv.put(NATIVE_LIVE_SUMMARY_KEY, next);
    },
  };
}

export type NativeLiveSummary = ReturnType<typeof createNativeLiveSummary>;
