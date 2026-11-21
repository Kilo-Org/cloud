import { useSyncExternalStore } from 'react';

export interface TabTakeOverPrompt {
  readonly requestId: string;
  readonly sessionTitle: string;
  readonly tabId: number;
}

/** `stopped`: the turn was stopped while the card showed; the card went away unanswered. */
export type TabTakeOverAnswer = 'cancel' | 'stopped' | 'take_over';

/*
 * One take-over question at a time. The tool call that hit an agent-held tab
 * waits here; the panel renders the card and answers it. A reload drops the
 * waiting call with the panel, so the prompt is deliberately not persisted.
 */
// oxlint-disable-next-line unicorn/no-useless-undefined -- init-declarations requires an initializer; the prompt is absent until a call asks.
let prompt: TabTakeOverPrompt | undefined = undefined;
const resolutions = new Map<string, (answer: TabTakeOverAnswer) => void>();
const listeners = new Set<() => void>();

const emit = (): void => {
  for (const listener of listeners) {
    listener();
  }
};

const settleTabTakeOver = (requestId: string, answer: TabTakeOverAnswer): void => {
  const resolve = resolutions.get(requestId);

  resolutions.delete(requestId);

  if (prompt?.requestId === requestId) {
    prompt = undefined;
    emit();
  }

  resolve?.(answer);
};

/** A settled request ignores the answer: a click on a card that already went away does nothing. */
export const answerTabTakeOver = (requestId: string, accepted: boolean): void => {
  settleTabTakeOver(requestId, accepted ? 'take_over' : 'cancel');
};

export const requestTabTakeOver = ({
  signal,
  ...request
}: {
  readonly sessionTitle: string;
  readonly signal?: AbortSignal | undefined;
  readonly tabId: number;
}): Promise<TabTakeOverAnswer> => {
  if (signal?.aborted === true) {
    return Promise.resolve('stopped');
  }

  /*
   * Two conversations can ask at once. The card only answers the prompt it
   * shows, so the earlier request is settled as declined instead of being
   * abandoned: its tool call returns an answer, and its resolver does not leak.
   */
  if (prompt !== undefined) {
    answerTabTakeOver(prompt.requestId, false);
  }

  const requestId = crypto.randomUUID();
  const { promise, resolve } = Promise.withResolvers<TabTakeOverAnswer>();
  const onAbort = (): void => {
    settleTabTakeOver(requestId, 'stopped');
  };

  resolutions.set(requestId, answer => {
    signal?.removeEventListener('abort', onAbort);
    resolve(answer);
  });
  signal?.addEventListener('abort', onAbort);
  prompt = { requestId, ...request };
  emit();

  return promise;
};

export const subscribeTabTakeOver = (listener: () => void): (() => void) => {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
};

export const currentTabTakeOver = (): TabTakeOverPrompt | undefined => prompt;

export const useTabTakeOver = (): TabTakeOverPrompt | undefined =>
  useSyncExternalStore(subscribeTabTakeOver, currentTabTakeOver, currentTabTakeOver);
