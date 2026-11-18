import { describe, expect, it } from 'vitest';
import type { SessionCredentialGrant } from '../../sandbox-control/session-credentials.js';
import {
  memberHandleForSession,
  selectHandoffCandidate,
  setAllMemberHandles,
  sharedCanonicalHandleSurvivesRelease,
  type HandoffMemberState,
} from './scope-handle-rotation.js';

function grantWithMembers(
  members: readonly { sessionId: string; kiloSessionId: string; handle: string }[]
): SessionCredentialGrant {
  return { kilo: { runtimeProxy: { members: [...members] } } } as unknown as SessionCredentialGrant;
}

function member(overrides: Partial<HandoffMemberState>): HandoffMemberState {
  return {
    sessionId: 's1',
    kiloSessionId: 'k1',
    handle: 'h1',
    delegationExpiresAt: 10_000,
    active: true,
    ...overrides,
  };
}

describe('selectHandoffCandidate', () => {
  it('picks the active member whose live delegation extends furthest past the canonical', () => {
    const candidate = selectHandoffCandidate({
      canonicalExp: 1_000,
      members: [
        member({ sessionId: 'a', delegationExpiresAt: 2_000 }),
        member({ sessionId: 'b', delegationExpiresAt: 5_000 }),
        member({ sessionId: 'c', delegationExpiresAt: 4_000 }),
      ],
    });
    expect(candidate).toEqual({ sessionId: 'b', kiloSessionId: 'k1', delegationExpiresAt: 5_000 });
  });

  it('never picks a member whose delegation does not outlive the canonical', () => {
    expect(
      selectHandoffCandidate({
        canonicalExp: 5_000,
        members: [
          member({ delegationExpiresAt: 5_000 }),
          member({ sessionId: 'b', delegationExpiresAt: 4_000 }),
        ],
      })
    ).toBeNull();
  });

  it('ignores inactive members and unavailable delegation', () => {
    expect(
      selectHandoffCandidate({
        canonicalExp: 1_000,
        members: [
          member({ sessionId: 'a', delegationExpiresAt: 9_000, active: false }),
          member({ sessionId: 'b', delegationExpiresAt: null }),
        ],
      })
    ).toBeNull();
  });
});

describe('setAllMemberHandles', () => {
  it('sets the canonical handle on every member row', () => {
    const grant = grantWithMembers([
      { sessionId: 'a', kiloSessionId: 'ka', handle: 'old' },
      { sessionId: 'b', kiloSessionId: 'kb', handle: 'old' },
    ]);
    const updated = setAllMemberHandles(grant, 'new');
    expect(updated.kilo.runtimeProxy?.members.map(row => row.handle)).toEqual(['new', 'new']);
  });

  it('returns the same grant when every row already holds the handle', () => {
    const grant = grantWithMembers([{ sessionId: 'a', kiloSessionId: 'ka', handle: 'new' }]);
    expect(setAllMemberHandles(grant, 'new')).toBe(grant);
  });

  it('returns the same grant when there is no proxy projection', () => {
    const grant = { kilo: {} } as unknown as SessionCredentialGrant;
    expect(setAllMemberHandles(grant, 'new')).toBe(grant);
    expect(memberHandleForSession(grant, 'a')).toBeNull();
  });
});

describe('sharedCanonicalHandleSurvivesRelease', () => {
  it('is true only while another member shares the released handle', () => {
    const shared = grantWithMembers([
      { sessionId: 'a', kiloSessionId: 'ka', handle: 'h' },
      { sessionId: 'b', kiloSessionId: 'kb', handle: 'h' },
    ]);
    expect(sharedCanonicalHandleSurvivesRelease(shared, 'a')).toBe(true);
    expect(sharedCanonicalHandleSurvivesRelease(shared, 'c')).toBe(false);
    expect(sharedCanonicalHandleSurvivesRelease(null, 'a')).toBe(false);
  });

  it('is false for the last member and for distinct per-session handles', () => {
    const last = grantWithMembers([{ sessionId: 'a', kiloSessionId: 'ka', handle: 'h' }]);
    expect(sharedCanonicalHandleSurvivesRelease(last, 'a')).toBe(false);
    const distinct = grantWithMembers([
      { sessionId: 'a', kiloSessionId: 'ka', handle: 'ha' },
      { sessionId: 'b', kiloSessionId: 'kb', handle: 'hb' },
    ]);
    expect(sharedCanonicalHandleSurvivesRelease(distinct, 'a')).toBe(false);
  });
});
