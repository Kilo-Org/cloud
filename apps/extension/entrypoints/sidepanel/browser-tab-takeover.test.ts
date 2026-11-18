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
    await expect(first).resolves.toBe(false);

    // The card answers the prompt it shows: only the second request is still open.
    answerTabTakeOver(secondId, true);
    await expect(second).resolves.toBe(true);
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
    await expect(first).resolves.toBe(false);
    unsubscribe();
    expect(currentTabTakeOver()).toBeUndefined();
  });
});
