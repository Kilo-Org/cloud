import { resolvePendingFirstChatView, type PendingFirstChat } from './pending-first-chat';

const pending: PendingFirstChat = {
  operationKey: 'op-1',
  initialMessageId: 'msg-initial',
  prompt: 'hello',
  attachmentNames: [],
  kiloSessionId: 'ses-real',
};

function view(overrides: Partial<Parameters<typeof resolvePendingFirstChatView>[0]> = {}) {
  return resolvePendingFirstChatView({
    pending,
    requestedSessionId: 'ses-real',
    visibleMessageIds: [],
    transcriptPhase: 'opening',
    hasMessages: false,
    fetchedSession: { kiloSessionId: 'ses-real', initialMessageId: 'msg-initial' },
    ...overrides,
  });
}

describe('resolvePendingFirstChatView', () => {
  it('keeps showing the prompt while the real session is still opening', () => {
    expect(view()).toBe('show');
  });

  it('keeps showing while the live transcript is still empty', () => {
    expect(view({ transcriptPhase: 'live', hasMessages: false })).toBe('show');
  });

  it('clears when a live transcript has rows but not the first message', () => {
    expect(view({ transcriptPhase: 'live', hasMessages: true })).toBe('clear');
  });

  it('clears once the real row with the same initial message id is visible', () => {
    expect(view({ visibleMessageIds: ['msg-initial'], transcriptPhase: 'live' })).toBe('clear');
  });

  it('clears when the fetched session reports a different initial message id', () => {
    expect(
      view({ fetchedSession: { kiloSessionId: 'ses-real', initialMessageId: 'msg-other' } })
    ).toBe('clear');
  });

  it('keeps showing while the manager still holds the previously open session', () => {
    expect(
      view({ fetchedSession: { kiloSessionId: 'ses-previous', initialMessageId: 'msg-previous' } })
    ).toBe('show');
    expect(view({ fetchedSession: null })).toBe('show');
  });

  it('clears on a failed opening', () => {
    expect(view({ transcriptPhase: 'failed' })).toBe('clear');
  });

  it('is idle when no session is bound or the user navigated elsewhere', () => {
    expect(view({ pending: null })).toBe('idle');
    expect(view({ requestedSessionId: 'ses-other' })).toBe('idle');
    expect(view({ pending: { ...pending, kiloSessionId: null } })).toBe('idle');
  });
});
