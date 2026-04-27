import { shouldSkipUpdateForMergeCommit } from '@/lib/integrations/platforms/gitlab/webhook-handlers/merge-request-handler';

describe('shouldSkipUpdateForMergeCommit', () => {
  it('returns false for non-update actions without calling the check', async () => {
    const actions: Array<string | undefined> = ['open', 'reopen', 'close', 'merge', undefined];
    for (const action of actions) {
      let called = false;
      const result = await shouldSkipUpdateForMergeCommit({
        action,
        check: async () => {
          called = true;
          return true;
        },
      });

      expect(result).toBe(false);
      expect(called).toBe(false);
    }
  });

  it('returns true when update head is a merge commit', async () => {
    const result = await shouldSkipUpdateForMergeCommit({
      action: 'update',
      check: async () => true,
    });

    expect(result).toBe(true);
  });

  it('returns false when update head is not a merge commit', async () => {
    const result = await shouldSkipUpdateForMergeCommit({
      action: 'update',
      check: async () => false,
    });

    expect(result).toBe(false);
  });

  it('fails open when the check throws (review proceeds)', async () => {
    const result = await shouldSkipUpdateForMergeCommit({
      action: 'update',
      check: async () => {
        throw new Error('GitLab API unreachable');
      },
    });

    expect(result).toBe(false);
  });
});
