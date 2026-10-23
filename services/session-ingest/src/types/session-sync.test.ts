import { describe, expect, it } from 'vitest';

import { SessionItemSchema } from './session-sync';

describe('SessionItemSchema agent_notification validation', () => {
  it('parses a valid agent_notification item', () => {
    const result = SessionItemSchema.safeParse({
      type: 'agent_notification',
      data: { id: 'note_1', message: 'Build done' },
    });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      type: 'agent_notification',
      data: { id: 'note_1', message: 'Build done' },
    });
  });

  it('rejects an oversized message', () => {
    const result = SessionItemSchema.safeParse({
      type: 'agent_notification',
      data: { id: 'note_big', message: 'x'.repeat(501) },
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty message', () => {
    expect(
      SessionItemSchema.safeParse({
        type: 'agent_notification',
        data: { id: 'note_empty', message: '' },
      }).success
    ).toBe(false);
  });

  it('rejects a whitespace-only message after trim', () => {
    expect(
      SessionItemSchema.safeParse({
        type: 'agent_notification',
        data: { id: 'note_ws', message: '   ' },
      }).success
    ).toBe(false);
  });

  it('rejects slash-bearing notification IDs before persistence', () => {
    expect(
      SessionItemSchema.safeParse({
        type: 'agent_notification',
        data: { id: 'note/parent', message: 'Bad' },
      }).success
    ).toBe(false);
  });

  it('rejects NUL-bearing notification IDs before persistence', () => {
    expect(
      SessionItemSchema.safeParse({
        type: 'agent_notification',
        data: { id: 'note\u0000bad', message: 'Bad' },
      }).success
    ).toBe(false);
  });

  it('rejects notification IDs longer than 64 characters', () => {
    expect(
      SessionItemSchema.safeParse({
        type: 'agent_notification',
        data: { id: 'n'.repeat(65), message: 'Bad' },
      }).success
    ).toBe(false);
  });

  it('accepts notification IDs exactly 64 characters', () => {
    expect(
      SessionItemSchema.safeParse({
        type: 'agent_notification',
        data: { id: 'n'.repeat(64), message: 'OK' },
      }).success
    ).toBe(true);
  });
});

describe('SessionItemSchema session_pr_link validation', () => {
  it('parses a valid set', () => {
    const result = SessionItemSchema.safeParse({
      type: 'session_pr_link',
      data: { platform: 'github', prUrl: 'https://github.com/acme/widgets/pull/42', prNumber: 42 },
    });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      type: 'session_pr_link',
      data: { platform: 'github', prUrl: 'https://github.com/acme/widgets/pull/42', prNumber: 42 },
    });
  });

  it('parses a valid clear (all null)', () => {
    const result = SessionItemSchema.safeParse({
      type: 'session_pr_link',
      data: { platform: null, prUrl: null, prNumber: null },
    });
    expect(result.success).toBe(true);
  });

  it('parses optional headRef and headSha evidence', () => {
    const result = SessionItemSchema.safeParse({
      type: 'session_pr_link',
      data: {
        platform: 'github',
        prUrl: 'https://github.com/acme/widgets/pull/42',
        prNumber: 42,
        headRef: 'fix/typo',
        headSha: 'abc123',
      },
    });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      type: 'session_pr_link',
      data: {
        platform: 'github',
        prUrl: 'https://github.com/acme/widgets/pull/42',
        prNumber: 42,
        headRef: 'fix/typo',
        headSha: 'abc123',
      },
    });
  });

  it('parses a set without head evidence for older CLIs', () => {
    const result = SessionItemSchema.safeParse({
      type: 'session_pr_link',
      data: { platform: 'github', prUrl: 'https://github.com/acme/widgets/pull/42', prNumber: 42 },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an empty platform', () => {
    expect(
      SessionItemSchema.safeParse({
        type: 'session_pr_link',
        data: { platform: '', prUrl: 'https://x', prNumber: 1 },
      }).success
    ).toBe(false);
  });

  it('rejects an empty prUrl', () => {
    expect(
      SessionItemSchema.safeParse({
        type: 'session_pr_link',
        data: { platform: 'github', prUrl: '', prNumber: 1 },
      }).success
    ).toBe(false);
  });

  it('rejects a non-positive prNumber', () => {
    expect(
      SessionItemSchema.safeParse({
        type: 'session_pr_link',
        data: { platform: 'github', prUrl: 'https://x', prNumber: 0 },
      }).success
    ).toBe(false);
  });

  it('rejects a non-integer prNumber', () => {
    expect(
      SessionItemSchema.safeParse({
        type: 'session_pr_link',
        data: { platform: 'github', prUrl: 'https://x', prNumber: 1.5 },
      }).success
    ).toBe(false);
  });

  it('rejects a prNumber above the PostgreSQL int4 range', () => {
    expect(
      SessionItemSchema.safeParse({
        type: 'session_pr_link',
        data: { platform: 'github', prUrl: 'https://x', prNumber: 2_147_483_648 },
      }).success
    ).toBe(false);
  });
});

describe('SessionItemSchema session_status validation', () => {
  it('preserves the original transition tuple without dropping its causal identity', () => {
    const item = {
      type: 'session_status',
      data: {
        status: 'question',
        previousStatus: 'busy',
        occurredAt: '2026-07-24T07:59:00.000Z',
        transitionId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      },
    };
    expect(SessionItemSchema.parse(item)).toEqual(item);
  });

  it.each(['not-an-id', 'Z1ARZ3NDEKTSV4RRFFQ69G5FAV', '01arz3ndektsv4rrffq69g5fav'])(
    'rejects noncanonical or overflowing transition identity %s',
    transitionId => {
      expect(
        SessionItemSchema.safeParse({
          type: 'session_status',
          data: { status: 'question', transitionId },
        }).success
      ).toBe(false);
    }
  );

  it('preserves an originating historical transition timestamp independently from scheduledAt', () => {
    const item = {
      type: 'session_status',
      data: {
        status: 'question',
        occurredAt: '2026-07-24T07:59:00.000Z',
      },
    };
    expect(SessionItemSchema.parse(item)).toEqual(item);
  });

  it('rejects malformed originating timestamps instead of treating them as history', () => {
    expect(
      SessionItemSchema.safeParse({
        type: 'session_status',
        data: { status: 'question', occurredAt: 'yesterday' },
      }).success
    ).toBe(false);
  });

  it.each(['idle', 'busy', 'question', 'permission', 'retry'])(
    'parses the known %s status',
    status => {
      expect(
        SessionItemSchema.safeParse({ type: 'session_status', data: { status } }).success
      ).toBe(true);
    }
  );

  it('parses the scheduled status with its wake time', () => {
    const result = SessionItemSchema.safeParse({
      type: 'session_status',
      data: { status: 'scheduled', scheduledAt: '2026-09-24T09:00:00.000Z' },
    });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      type: 'session_status',
      data: { status: 'scheduled', scheduledAt: '2026-09-24T09:00:00.000Z' },
    });
  });

  it('parses scheduled without a wake time', () => {
    const result = SessionItemSchema.safeParse({
      type: 'session_status',
      data: { status: 'scheduled' },
    });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ type: 'session_status', data: { status: 'scheduled' } });
  });

  it('parses an unrecognized status without dropping the item', () => {
    const result = SessionItemSchema.safeParse({
      type: 'session_status',
      data: { status: 'some-future-status' },
    });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      type: 'session_status',
      data: { status: 'some-future-status' },
    });
  });

  it('parses scheduled with an explicit null wake time', () => {
    const result = SessionItemSchema.safeParse({
      type: 'session_status',
      data: { status: 'scheduled', scheduledAt: null },
    });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      type: 'session_status',
      data: { status: 'scheduled', scheduledAt: null },
    });
  });
});

describe('SessionItemSchema storage key identity', () => {
  it('rejects slash-bearing message IDs before persistence', () => {
    expect(
      SessionItemSchema.safeParse({ type: 'message', data: { id: 'msg_parent/child' } }).success
    ).toBe(false);
  });

  it('rejects slash-bearing part message IDs before persistence', () => {
    expect(
      SessionItemSchema.safeParse({
        type: 'part',
        data: { id: 'prt_child', messageID: 'msg_parent/child' },
      }).success
    ).toBe(false);
  });

  it('rejects slash-bearing part IDs before persistence', () => {
    expect(
      SessionItemSchema.safeParse({
        type: 'part',
        data: { id: 'prt_parent/child', messageID: 'msg_parent' },
      }).success
    ).toBe(false);
  });

  it('rejects NUL-bearing message IDs before persistence', () => {
    expect(
      SessionItemSchema.safeParse({ type: 'message', data: { id: 'msg_parent\u0000child' } })
        .success
    ).toBe(false);
  });

  it('rejects NUL-bearing part message IDs before persistence', () => {
    expect(
      SessionItemSchema.safeParse({
        type: 'part',
        data: { id: 'prt_child', messageID: 'msg_parent\u0000child' },
      }).success
    ).toBe(false);
  });

  it('rejects NUL-bearing part IDs before persistence', () => {
    expect(
      SessionItemSchema.safeParse({
        type: 'part',
        data: { id: 'prt_parent\u0000child', messageID: 'msg_parent' },
      }).success
    ).toBe(false);
  });
});

describe('SessionItemSchema identity segments', () => {
  it.each(['message', 'part', 'agent_notification'])(
    'refuses a part whose message id equals the %s root',
    reserved => {
      expect(
        SessionItemSchema.safeParse({
          type: 'part',
          data: { id: 'prt_child', messageID: reserved },
        }).success
      ).toBe(false);
    }
  );

  it.each(['message', 'part', 'agent_notification'])(
    'refuses a message whose id equals the %s root',
    reserved => {
      expect(SessionItemSchema.safeParse({ type: 'message', data: { id: reserved } }).success).toBe(
        false
      );
    }
  );

  it('accepts ordinary message and part identities', () => {
    expect(
      SessionItemSchema.safeParse({
        type: 'message',
        data: { id: 'msg_42', role: 'assistant' },
      }).success
    ).toBe(true);
    expect(
      SessionItemSchema.safeParse({
        type: 'part',
        data: { id: 'prt_1', messageID: 'msg_42' },
      }).success
    ).toBe(true);
  });

  it('accepts a part id equal to an item-type root', () => {
    expect(
      SessionItemSchema.safeParse({
        type: 'part',
        data: { id: 'message', messageID: 'msg_42' },
      }).success
    ).toBe(true);
  });
});
