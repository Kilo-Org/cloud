import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  postSession: vi.fn(),
  dismissSession: vi.fn(),
  pruneSessions: vi.fn(),
  getSessionCards: vi.fn<() => string>(() => '[]'),
  native: null as Record<string, unknown> | null,
}));

vi.mock('expo', () => ({
  requireOptionalNativeModule: () => mocks.native,
}));

mocks.native = {
  postSession: mocks.postSession,
  dismissSession: mocks.dismissSession,
  pruneSessions: mocks.pruneSessions,
  getSessionCards: mocks.getSessionCards,
};

const { dismissSessionCard, getStoredSessionCards, postSessionCard, pruneSessionCards } =
  await import('./session-notification');

/** The card the bridge hands over, read off the bridge itself. */
type SessionNotificationCard = Parameters<typeof postSessionCard>[0];

const CARD: SessionNotificationCard = {
  sessionId: 'session-1',
  organizationId: 'org-1',
  title: 'Migrate the billing webhooks',
  text: 'Working',
  subText: null,
  compactText: null,
  openLabel: 'Open',
  openUrl: 'kiloapp:///cloud/sessions/session-1',
  approveLabel: null,
  approvalKey: null,
  whenMs: Date.parse('2026-10-12T09:48:00.000Z'),
  chronometer: true,
  quietAtMs: 0,
  quietWhenMs: 0,
  quietText: null,
  promotion: true,
  color: '#4F5A10',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.native = {
    postSession: mocks.postSession,
    dismissSession: mocks.dismissSession,
    pruneSessions: mocks.pruneSessions,
    getSessionCards: mocks.getSessionCards,
  };
  mocks.getSessionCards.mockReturnValue('[]');
});

describe('session notification bridge', () => {
  it('posts the card as JSON text with the finished window', () => {
    postSessionCard(CARD, 900_000);

    expect(mocks.postSession).toHaveBeenCalledTimes(1);
    const [text, dismissAfterMs] = mocks.postSession.mock.calls[0] ?? [];
    expect(dismissAfterMs).toBe(900_000);
    expect(JSON.parse(String(text))).toMatchObject({
      sessionId: 'session-1',
      organizationId: 'org-1',
      chronometer: true,
    });
  });

  it('dismisses by session id and prunes against a JSON list', () => {
    dismissSessionCard('session-1');
    pruneSessionCards(['session-1', 'session-2']);

    expect(mocks.dismissSession).toHaveBeenCalledWith('session-1');
    expect(mocks.pruneSessions).toHaveBeenCalledWith('["session-1","session-2"]');
  });

  it('reads the stored cards and drops a record that no longer parses', () => {
    mocks.getSessionCards.mockReturnValue(
      JSON.stringify([
        { sessionId: 'session-1', organizationId: 'org-1', approvalKey: 'a'.repeat(64) },
        { sessionId: '', organizationId: null, approvalKey: null },
      ])
    );

    expect(getStoredSessionCards()).toEqual([
      { sessionId: 'session-1', organizationId: 'org-1', approvalKey: 'a'.repeat(64) },
    ]);
  });

  it('reads the empty string the native store writes for an absent field as null', () => {
    // Kotlin `toJson` writes `""` for a Personal follow's organization and a card
    // with no approval key; the restore compares the scope against null.
    mocks.getSessionCards.mockReturnValue(
      JSON.stringify([{ sessionId: 'session-1', organizationId: '', approvalKey: '' }])
    );

    expect(getStoredSessionCards()).toEqual([
      { sessionId: 'session-1', organizationId: null, approvalKey: null },
    ]);
  });

  it('answers an empty list when the native read is missing or not JSON', () => {
    mocks.native = null;
    expect(getStoredSessionCards()).toEqual([]);

    mocks.native = { getSessionCards: mocks.getSessionCards };
    mocks.getSessionCards.mockReturnValue('not json');
    expect(getStoredSessionCards()).toEqual([]);
  });
});
