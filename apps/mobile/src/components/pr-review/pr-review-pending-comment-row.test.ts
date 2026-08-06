// Feature states for the pending-comment removal outcome helper:
// - Confirmed remove (the item was still queued at delete-confirm time, so
//   the provider's synchronous id-filter definitely dropped it): one
//   announcement and one focus move.
// - Failed/absent remove (stale id already dropped): the helper announces
//   nothing and moves no focus, mirroring the confirmed-success gate on the
//   session-list delete focus handoff.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { focusAfterPendingCommentRemoval } from './pr-review-pending-comment-row';

const announceForA11yMock = vi.hoisted(() => vi.fn());
const moveA11yFocusMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/a11y/announce', () => ({
  announceForA11y: announceForA11yMock,
  moveA11yFocus: moveA11yFocusMock,
}));

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  TextInput: 'TextInput',
  View: 'View',
}));

vi.mock('lucide-react-native', () => ({
  Trash2: 'Trash2',
}));

vi.mock('@/components/ui/text', () => ({
  Text: 'Text',
}));

vi.mock('@/components/pr-review/pr-form-sheet-chrome', () => ({
  useFormSheetKeyboardVisible: () => false,
}));

vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#000000' }),
}));

vi.mock('@/lib/utils', () => ({
  cn: (...inputs: unknown[]) => inputs.filter(Boolean).join(' '),
}));

describe('focusAfterPendingCommentRemoval', () => {
  beforeEach(() => {
    announceForA11yMock.mockClear();
    moveA11yFocusMock.mockClear();
  });

  it('announces the deletion and moves focus once when the remove is confirmed', () => {
    const inputRef = { current: null };

    focusAfterPendingCommentRemoval(inputRef, true);

    expect(announceForA11yMock).toHaveBeenCalledTimes(1);
    expect(announceForA11yMock).toHaveBeenCalledWith('Pending comment deleted');
    expect(moveA11yFocusMock).toHaveBeenCalledTimes(1);
    expect(moveA11yFocusMock).toHaveBeenCalledWith(inputRef);
  });

  it('announces nothing and moves no focus when the remove did not happen', () => {
    const inputRef = { current: null };

    focusAfterPendingCommentRemoval(inputRef, false);

    expect(announceForA11yMock).not.toHaveBeenCalled();
    expect(moveA11yFocusMock).not.toHaveBeenCalled();
  });
});
