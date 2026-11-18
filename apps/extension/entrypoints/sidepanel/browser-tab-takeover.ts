import { useSyncExternalStore } from 'react';

export interface TabTakeOverPrompt {
  readonly requestId: string;
  readonly sessionTitle: string;
  readonly tabId: number;
}

/*
 * One take-over question at a time. The tool call that hit an agent-held tab
 * waits here; the panel renders the card and answers it. A reload drops the
 * waiting call with the panel, so the prompt is deliberately not persisted.
 */
// oxlint-disable-next-line unicorn/no-useless-undefined -- init-declarations requires an initializer; the prompt is absent until a call asks.
let prompt: TabTakeOverPrompt | undefined = undefined;
const resolutions = new Map<string, (accepted: boolean) => void>();
const listeners = new Set<() => void>();

const emit = (): void => {
  for (const listener of listeners) {
    listener();
  }
};

export const answerTabTakeOver = (requestId: string, accepted: boolean): void => {
  const resolve = resolutions.get(requestId);

  resolutions.delete(requestId);

  if (prompt?.requestId === requestId) {
    prompt = undefined;
    emit();
  }

  resolve?.(accepted);
};

export const requestTabTakeOver = (request: {
  readonly sessionTitle: string;
  readonly tabId: number;
}): Promise<boolean> => {
  /*
   * Two conversations can ask at once. The card only answers the prompt it
   * shows, so the earlier request is settled as declined instead of being
   * abandoned: its tool call returns an answer, and its resolver does not leak.
   */
  if (prompt !== undefined) {
    answerTabTakeOver(prompt.requestId, false);
  }

  const requestId = crypto.randomUUID();
  const { promise, resolve } = Promise.withResolvers<boolean>();

  resolutions.set(requestId, resolve);
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
