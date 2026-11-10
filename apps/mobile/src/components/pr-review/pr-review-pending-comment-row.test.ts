import { createRef } from 'react';
import { type TextInput } from 'react-native';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { focusAfterPendingCommentRemoval } from './pr-review-pending-comment-row';

const a11y = vi.hoisted(() => ({
  announceForA11y: vi.fn(),
  requestA11yFocus: vi.fn<(ref: { current: unknown }) => boolean>(() => true),
}));

const i18nMock = vi.hoisted(() => ({
  i18n: { t: vi.fn((key: string) => `localized:${key}`) },
}));

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  TextInput: 'TextInput',
  View: 'View',
}));

vi.mock('@/lib/a11y/announce', () => a11y);
vi.mock('@/i18n', () => i18nMock);
vi.mock('@/components/ui/icons', () => ({ Trash2: 'Trash2' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/pr-review/pr-form-sheet-chrome', () => ({
  useFormSheetKeyboardVisible: () => false,
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#000000' }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('focusAfterPendingCommentRemoval', () => {
  it('announces the removal before it requests focus on the composer', () => {
    const inputRef = createRef<TextInput>();

    focusAfterPendingCommentRemoval(inputRef, true);

    expect(a11y.announceForA11y).toHaveBeenCalledExactlyOnceWith(
      'localized:prReview.pendingComment.deletedAnnouncement'
    );
    expect(a11y.requestA11yFocus).toHaveBeenCalledExactlyOnceWith(inputRef);
    expect(a11y.announceForA11y.mock.invocationCallOrder[0]).toBeLessThan(
      a11y.requestA11yFocus.mock.invocationCallOrder[0] as number
    );
  });

  it('says nothing when the removal reported no change', () => {
    // A stale id resolves to no removal, and the sheet must not steal focus for
    // a comment that is still queued.
    focusAfterPendingCommentRemoval(createRef<TextInput>(), false);

    expect(a11y.announceForA11y).not.toHaveBeenCalled();
    expect(a11y.requestA11yFocus).not.toHaveBeenCalled();
  });
});
