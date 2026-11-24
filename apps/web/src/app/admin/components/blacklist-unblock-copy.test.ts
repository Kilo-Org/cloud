import { describe, expect, it } from '@jest/globals';
import { unblockPreviewMessage, unblockResultMessage } from './blacklist-unblock-copy';

describe('unblockPreviewMessage', () => {
  it('shows the positive-balance accounts that would be unblocked', () => {
    expect(
      unblockPreviewMessage({ unblockable: 12, keptBlocked: 0, stillBlacklistedBy: null })
    ).toBe('This will unblock 12 accounts with a positive balance.');
    expect(
      unblockPreviewMessage({ unblockable: 1, keptBlocked: 0, stillBlacklistedBy: null })
    ).toBe('This will unblock 1 account with a positive balance.');
  });

  it('shows how many accounts stay blocked without a balance', () => {
    expect(
      unblockPreviewMessage({ unblockable: 4, keptBlocked: 3, stillBlacklistedBy: null })
    ).toBe(
      'This will unblock 4 accounts with a positive balance. 3 accounts with no remaining balance stay blocked.'
    );
    expect(
      unblockPreviewMessage({ unblockable: 0, keptBlocked: 3, stillBlacklistedBy: null })
    ).toBe(
      'No accounts with a positive balance would be unblocked. 3 accounts with no remaining balance stay blocked.'
    );
  });

  it('explains when nothing is blocked by the domain', () => {
    expect(
      unblockPreviewMessage({ unblockable: 0, keptBlocked: 0, stillBlacklistedBy: null })
    ).toBe('No accounts are currently blocked by this domain.');
  });

  it('names the entry that still covers the domain', () => {
    expect(
      unblockPreviewMessage({ unblockable: 0, keptBlocked: 3, stillBlacklistedBy: 'example.com' })
    ).toBe(
      'This domain is still covered by the "example.com" blacklist entry. Remove that entry first.'
    );
  });
});

describe('unblockResultMessage', () => {
  it('reports removal without unblocking as keeping existing blocks', () => {
    expect(
      unblockResultMessage('spam.example', {
        removed: true,
        unblock: {
          requested: false,
          unblocked: 0,
          keptBlocked: 0,
          remaining: false,
          failed: false,
        },
      })
    ).toEqual({
      kind: 'success',
      message: 'Removed spam.example. Existing user blocks were kept.',
    });
  });

  it('reports the unblocked account count and accounts kept blocked', () => {
    expect(
      unblockResultMessage('spam.example', {
        removed: true,
        unblock: {
          requested: true,
          unblocked: 4,
          keptBlocked: 2,
          remaining: false,
          failed: false,
        },
      })
    ).toEqual({
      kind: 'success',
      message: 'Removed spam.example. Unblocked 4 accounts. 2 accounts stay blocked.',
    });
  });

  it('asks the admin to continue while batches remain', () => {
    expect(
      unblockResultMessage('spam.example', {
        removed: true,
        unblock: {
          requested: true,
          unblocked: 1000,
          keptBlocked: 0,
          remaining: true,
          failed: false,
        },
      })
    ).toEqual({
      kind: 'warning',
      message:
        'Removed spam.example. Unblocked 1,000 accounts; more remain. Run it again to finish.',
    });
  });

  it('reports an unblock failure without hiding the removal', () => {
    expect(
      unblockResultMessage('spam.example', {
        removed: true,
        unblock: {
          requested: true,
          unblocked: 0,
          keptBlocked: 0,
          remaining: false,
          failed: true,
        },
      })
    ).toEqual({
      kind: 'warning',
      message: 'Removed spam.example, but unblocking accounts failed. Run it again to finish.',
    });
  });

  it('explains when no positive-balance accounts were unblocked', () => {
    expect(
      unblockResultMessage('spam.example', {
        removed: true,
        unblock: {
          requested: true,
          unblocked: 0,
          keptBlocked: 3,
          remaining: false,
          failed: false,
        },
      })
    ).toEqual({
      kind: 'success',
      message:
        'Removed spam.example. No accounts with a positive balance were unblocked. 3 accounts stay blocked.',
    });
  });
});
