import { describe, expect, it } from '@jest/globals';
import type { Message, Thread } from 'chat';
import { shouldUseSeparatePullRequestStrategy } from './pr-creation-strategy';

function createThread(id: string, adapterName = 'github'): Thread {
  return { id, adapter: { name: adapterName } } as Thread;
}

function createMessage(text: string, raw: unknown = {}): Message {
  return { id: 'comment-1', text, raw } as Message;
}

describe('shouldUseSeparatePullRequestStrategy', () => {
  it('detects an explicit new PR request in a GitHub PR review thread', () => {
    expect(
      shouldUseSeparatePullRequestStrategy({
        thread: createThread('github:Kilo-Org/cloud:3427:rc:123'),
        message: createMessage('@kilocode open a new PR with an updated REVIEW.md per this thread'),
      })
    ).toBe(true);
  });

  it('detects an explicit new pull request request in a GitHub PR issue comment', () => {
    expect(
      shouldUseSeparatePullRequestStrategy({
        thread: createThread('github:Kilo-Org/cloud:issue:3427'),
        message: createMessage('@kilocode create a new pull request for this', {
          issue: { pull_request: {} },
        }),
      })
    ).toBe(true);
  });

  it('detects an explicit separate PR request in a GitHub PR thread', () => {
    expect(
      shouldUseSeparatePullRequestStrategy({
        thread: createThread('github:Kilo-Org/cloud:3427'),
        message: createMessage('@kilocode use a separate PR for this change'),
      })
    ).toBe(true);
  });

  it('does not trigger for a normal Kilo mention in a GitHub PR thread', () => {
    expect(
      shouldUseSeparatePullRequestStrategy({
        thread: createThread('github:Kilo-Org/cloud:3427:rc:123'),
        message: createMessage('@kilocode update REVIEW.md per this thread'),
      })
    ).toBe(false);
  });

  it('respects negated new PR requests', () => {
    expect(
      shouldUseSeparatePullRequestStrategy({
        thread: createThread('github:Kilo-Org/cloud:3427:rc:123'),
        message: createMessage('@kilocode don\u2019t open a new PR; update this PR'),
      })
    ).toBe(false);

    expect(
      shouldUseSeparatePullRequestStrategy({
        thread: createThread('github:Kilo-Org/cloud:3427:rc:123'),
        message: createMessage('@kilocode no new PR, just summarize this thread'),
      })
    ).toBe(false);
  });

  it('does not trigger for GitHub issue-only context', () => {
    expect(
      shouldUseSeparatePullRequestStrategy({
        thread: createThread('github:Kilo-Org/cloud:issue:37'),
        message: createMessage('@kilocode open a new PR for this issue'),
      })
    ).toBe(false);
  });

  it('does not trigger outside GitHub', () => {
    expect(
      shouldUseSeparatePullRequestStrategy({
        thread: createThread('slack:C123:1700000000.000000', 'slack'),
        message: createMessage('@kilocode open a new PR with this change'),
      })
    ).toBe(false);
  });
});
