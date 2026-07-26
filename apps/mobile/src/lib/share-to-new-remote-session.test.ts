import { describe, expect, it } from 'vitest';

import {
  hasStagedShareId,
  SHARE_STAGED_SPAWN_NAVIGATION_CANCELLED_TOAST,
  SHARE_TO_NEW_REMOTE_SESSION_ALERT,
  shouldBlockRemoteRunOnSelection,
  shouldCancelSpawnNavigationForStagedShare,
} from '@/lib/share-to-new-remote-session';

describe('hasStagedShareId', () => {
  it.each([
    { shareId: undefined, expected: false },
    { shareId: '', expected: false },
    { shareId: 'share-abc', expected: true },
  ])('returns $expected for shareId=$shareId', ({ shareId, expected }) => {
    expect(hasStagedShareId(shareId)).toBe(expected);
  });
});

describe('shouldBlockRemoteRunOnSelection', () => {
  it.each([
    { shareStaged: true, next: { connectionId: 'c1' }, expected: true },
    { shareStaged: true, next: null, expected: false },
    { shareStaged: false, next: { connectionId: 'c1' }, expected: false },
    { shareStaged: false, next: null, expected: false },
  ])(
    'returns $expected when shareStaged=$shareStaged and next is $next',
    ({ shareStaged, next, expected }) => {
      expect(shouldBlockRemoteRunOnSelection(shareStaged, next)).toBe(expected);
    }
  );
});

describe('shouldCancelSpawnNavigationForStagedShare', () => {
  it.each([
    { shareStaged: true, expected: true },
    { shareStaged: false, expected: false },
  ])('returns $expected when shareStaged=$shareStaged', ({ shareStaged, expected }) => {
    expect(shouldCancelSpawnNavigationForStagedShare(shareStaged)).toBe(expected);
  });
});

describe('share-to-new-remote-session copy', () => {
  it('pins the remote Run-on block alert strings', () => {
    expect(SHARE_TO_NEW_REMOTE_SESSION_ALERT).toEqual({
      title: "Can't share to a new remote session",
      message:
        "A session started on a remote CLI can't receive shared text or files. Start a cloud session, or go back and pick the running CLI session from the share list.",
    });
  });

  it('pins the mid-spawn navigation-cancelled toast string', () => {
    expect(SHARE_STAGED_SPAWN_NAVIGATION_CANCELLED_TOAST).toBe(
      "Shared content can't start a remote session. The spawned session is in your session list."
    );
  });
});
