/* eslint-disable vitest/no-conditional-in-test -- the shared module keeps at most one prompt; each test reads the one it just created */
import { describe, expect, it } from 'vitest';
import {
  answerTabTakeOver,
  currentTabTakeOver,
  requestTabTakeOver,
  subscribeTabTakeOver,
} from './browser-tab-takeover';

// The prompt is a module singleton, so a test reads the one it just asked for.
const shownRequestId = (): string => {
  const prompt = currentTabTakeOver();

  if (prompt === undefined) {
    throw new Error('Expected a take-over prompt to be shown.');
  }

  return prompt.requestId;
};

describe('tab take-over prompt', () => {
  it('settles the earlier request as declined when a second one arrives', async () => {
    const first = requestTabTakeOver({ sessionTitle: 'First session', tabId: 7 });
    const firstId = shownRequestId();

    const second = requestTabTakeOver({ sessionTitle: 'Second session', tabId: 8 });
    const secondId = shownRequestId();

    // The first card is gone and its tool call gets an answer instead of waiting forever.
    expect(secondId).not.toBe(firstId);
    await expect(first).resolves.toBe('cancel');

    // The card answers the prompt it shows: only the second request is still open.
    answerTabTakeOver(secondId, true);
    await expect(second).resolves.toBe('take_over');
    expect(currentTabTakeOver()).toBeUndefined();
  });

  it('notifies subscribers when a new request replaces the shown prompt', async () => {
    let notifications = 0;
    const unsubscribe = subscribeTabTakeOver(() => {
      notifications += 1;
    });
    const first = requestTabTakeOver({ sessionTitle: 'First session', tabId: 7 });

    void requestTabTakeOver({ sessionTitle: 'Second session', tabId: 8 });

    // Three notifications: the first prompt appearing, then the replacement clearing it and showing the second.
    expect(notifications).toBe(3);

    answerTabTakeOver(shownRequestId(), false);
    await expect(first).resolves.toBe('cancel');
    unsubscribe();
    expect(currentTabTakeOver()).toBeUndefined();
  });

  it('takes the card away as stopped when the turn stops, and ignores a late click on it', async () => {
    const stop = new AbortController();
    const answer = requestTabTakeOver({ sessionTitle: 'Work', signal: stop.signal, tabId: 7 });
    const shownId = shownRequestId();

    stop.abort();

    expect(currentTabTakeOver()).toBeUndefined();
    await expect(answer).resolves.toBe('stopped');

    const next = requestTabTakeOver({ sessionTitle: 'Other', tabId: 8 });
    const nextId = shownRequestId();

    // The stale card's Take over must neither answer nor hide the card that replaced it.
    answerTabTakeOver(shownId, true);
    expect(currentTabTakeOver()?.requestId).toBe(nextId);

    answerTabTakeOver(nextId, false);
    await expect(next).resolves.toBe('cancel');
  });

  it('never shows a card for a turn that already stopped', async () => {
    const stop = new AbortController();

    stop.abort();

    await expect(
      requestTabTakeOver({ sessionTitle: 'Work', signal: stop.signal, tabId: 7 })
    ).resolves.toBe('stopped');
    expect(currentTabTakeOver()).toBeUndefined();
  });
});
