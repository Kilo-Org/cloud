import { describe, expect, it } from 'vitest';

import {
  PR_LINK_HELPER_CLIPBOARD_EMPTY_COPY,
  PR_LINK_HELPER_INVALID_COPY,
  selectPrLinkClearButtonVisible,
  selectPrLinkHelperSlotState,
} from './pr-link-helper-slot';

describe('selectPrLinkHelperSlotState', () => {
  it('returns none when no message is active', () => {
    expect(selectPrLinkHelperSlotState({ message: null })).toBe('none');
  });

  it('returns invalid when the invalid message is active', () => {
    expect(selectPrLinkHelperSlotState({ message: 'invalid' })).toBe('invalid');
  });

  it('exports the pinned helper copy strings', () => {
    expect(PR_LINK_HELPER_INVALID_COPY).toBe('Not a GitHub pull request link');
    expect(PR_LINK_HELPER_CLIPBOARD_EMPTY_COPY).toBe('Clipboard is empty');
  });
});

describe('selectPrLinkClearButtonVisible', () => {
  it('is present when the field has content', () => {
    expect(selectPrLinkClearButtonVisible({ hasInput: true })).toBe(true);
  });

  it('is absent when the field is empty', () => {
    expect(selectPrLinkClearButtonVisible({ hasInput: false })).toBe(false);
  });
});
