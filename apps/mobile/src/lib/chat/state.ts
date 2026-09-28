import { type Turn } from '@kilocode/harness-sdk';

/**
 * What a chat looks like to whoever is drawing it.
 *
 * A screen never holds this: it reads it. The conversation runs in the
 * registry whether or not a screen is mounted, and every change to one is
 * published to whoever is watching.
 */

/** What a chat screen draws. */
export type ChatState = {
  readonly sessionId: string;
  readonly model: string;
  /** Every turn the store holds, oldest first. */
  readonly turns: readonly Turn[];
  /** The answer arriving right now, empty when none is. */
  readonly answering: string;
  readonly status: 'opening' | 'idle' | 'working';
  /**
   * A question with no answer: still being asked, or asked and nothing came
   * back. `status` tells the two apart, and an idle chat holding one is what
   * puts a Retry under the last thing the person said.
   */
  readonly asked: string | null;
  /**
   * Questions typed while an answer was arriving, in the order they will be
   * asked. The composer stays open while the model works, so a person can ask
   * twice; a session answers one question at a time, so the second waits here
   * rather than racing the first.
   */
  readonly waiting: readonly string[];
  /** Why the last question ended with no answer, for the log rather than the screen. */
  readonly failed: string | null;
};

/**
 * What every chat looks like, open or not.
 *
 * It is kept apart from the sessions the registry holds, so a screen can
 * subscribe to a chat before it has opened and read the same object every time
 * it asks: a snapshot built fresh on each read would tell React the screen had
 * changed, forever.
 */
const states = new Map<string, ChatState>();

const watchers = new Map<string, Set<() => void>>();

/**
 * Where a chat that moved points, so a screen watching the one it left follows
 * to the one it became.
 *
 * Kept apart from the states, and carrying no copy of the conversation: a
 * screen reading the id it left has to see the moved chat's turns, not an
 * empty transcript, without a second copy of them being held per model switch.
 */
const movedTo = new Map<string, string>();

/** Follows a chain of moves to the chat a screen should read now. */
function resolve(sessionId: string): string {
  const seen = new Set<string>();
  let current = sessionId;
  while (!seen.has(current)) {
    seen.add(current);
    const next = movedTo.get(current);
    if (next === undefined) {
      return current;
    }
    current = next;
  }
  // A cycle cannot happen — a chat only ever moves onto a new session — but a
  // malformed one must not spin, so the id it came back to is the answer.
  return current;
}

/**
 * Whoever draws the list of chats, rather than one of them.
 *
 * A chat writes its turns when the answer ends, and the title of a row is the
 * first thing said in it — so a list drawn before that is a list with a row it
 * cannot name yet. The screen showing the list is not the screen the answer
 * arrived on, and may not even be mounted, so the registry says when a chat
 * changed and the list reads the database again.
 */
const listWatchers = new Set<() => void>();

export function watchChats(watcher: () => void): () => void {
  listWatchers.add(watcher);
  return () => {
    listWatchers.delete(watcher);
  };
}

/** A chat with nothing in it, which is what every chat starts as. */
export const NOTHING = {
  turns: [] as readonly Turn[],
  answering: '',
  asked: null,
  waiting: [] as readonly string[],
  failed: null,
} satisfies Omit<ChatState, 'sessionId' | 'model' | 'status'>;

function publish(sessionId: string): void {
  for (const watcher of watchers.get(sessionId) ?? []) {
    watcher();
  }
}

/** Changes what a chat looks like, and tells whoever is watching. */
export function change(sessionId: string, into: Partial<ChatState>): void {
  const target = resolve(sessionId);
  states.set(target, { ...snapshotOf(target), ...into });
  publish(target);
  if (target !== sessionId) {
    // A screen still watching the id the chat moved off reads the state above,
    // so it is told even though the state now lives under the new id.
    publish(sessionId);
  }
  // Only when a chat starts or stops working: every word of an answer is a
  // change too, and a list that read the database once per word would read it
  // hundreds of times for one answer.
  if (into.status !== undefined) {
    for (const watcher of listWatchers) {
      watcher();
    }
  }
}

/**
 * Points a chat that moved at the one it became, and drops the state it left.
 *
 * The state is not kept as a second copy under the old id: a screen reading it
 * resolves to the chat that carried on, so the transcript is never cleared, and
 * one conversation never becomes one copy per model switch.
 */
export function moveState(from: string, to: string): void {
  movedTo.set(from, to);
  states.delete(from);
  publish(from);
}

/** The state a screen draws, whether or not the chat has opened yet. */
export function snapshotOf(sessionId: string): ChatState {
  const target = resolve(sessionId);
  const held = states.get(target);
  if (held !== undefined) {
    return held;
  }
  const fresh: ChatState = { sessionId: target, model: '', status: 'opening', ...NOTHING };
  states.set(target, fresh);
  return fresh;
}

export function watch(sessionId: string, watcher: () => void): () => void {
  const held = watchers.get(sessionId) ?? new Set<() => void>();
  held.add(watcher);
  watchers.set(sessionId, held);
  return () => {
    held.delete(watcher);
    /* A chat that nothing watches any more holds nothing here. Without this the
       map keeps one empty set for every session a screen ever visited. */
    if (held.size === 0) {
      watchers.delete(sessionId);
    }
  };
}

/** Forgets a chat, which is what closing or deleting one does. */
export function forgetState(sessionId: string): void {
  /* A chat nothing points at any more needs no pointer to it: left behind, it
     would resolve a stale id onto a chat that no longer exists. The pointers
     are read before any is removed, so a chain resolves as it was. */
  const stale: string[] = [];
  for (const from of movedTo.keys()) {
    if (resolve(from) === sessionId) {
      stale.push(from);
    }
  }
  for (const from of stale) {
    movedTo.delete(from);
  }
  states.delete(sessionId);
}
