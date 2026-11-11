import { describe, expect, it } from 'vitest';
import { workspaceSnapshotsEnabled } from './workspace-snapshot.js';

describe('workspaceSnapshotsEnabled', () => {
  it.each([
    { userId: 'user-1' },
    { userId: 'user-2', orgId: 'org-1' },
    { userId: 'user-3', orgId: 'org-2' },
  ])('enables every owner with the production wildcard: %j', source => {
    expect(workspaceSnapshotsEnabled({ WORKSPACE_SNAPSHOT_IDS: '*' }, source)).toBe(true);
  });

  it.each([undefined, '', ' , ', 'other-id', 'prefix-*'])(
    'does not enroll an unmatched owner with %j',
    raw => {
      expect(
        workspaceSnapshotsEnabled(
          { WORKSPACE_SNAPSHOT_IDS: raw },
          { userId: 'user-1', orgId: 'org-1' }
        )
      ).toBe(false);
    }
  );

  it.each(['  *  ', 'other-id, *, another-id'])(
    'accepts a wildcard alongside whitespace or IDs: %j',
    raw => {
      expect(
        workspaceSnapshotsEnabled(
          { WORKSPACE_SNAPSHOT_IDS: raw },
          { userId: 'user-1', orgId: 'org-1' }
        )
      ).toBe(true);
    }
  );

  it.each(['user-1', 'org-1', 'other-id, user-1 ', 'other-id, org-1 '])(
    'enrolls an organization workspace by user or organization ID: %j',
    raw => {
      expect(
        workspaceSnapshotsEnabled(
          { WORKSPACE_SNAPSHOT_IDS: raw },
          { userId: 'user-1', orgId: 'org-1' }
        )
      ).toBe(true);
    }
  );

  it('enrolls a personal workspace by user ID', () => {
    expect(
      workspaceSnapshotsEnabled({ WORKSPACE_SNAPSHOT_IDS: 'user-1' }, { userId: 'user-1' })
    ).toBe(true);
  });

  it('does not enroll a personal workspace by an unrelated organization ID', () => {
    expect(
      workspaceSnapshotsEnabled({ WORKSPACE_SNAPSHOT_IDS: 'org-1' }, { userId: 'user-1' })
    ).toBe(false);
  });
});
