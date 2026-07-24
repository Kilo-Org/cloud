import { describe, expect, it } from 'vitest';

import {
  PR_LINK_HELPER_CLIPBOARD_EMPTY_COPY,
  PR_LINK_HELPER_INVALID_COPY,
  selectPrLinkHelperSlotState,
} from './pr-link-helper-slot';

describe('selectPrLinkHelperSlotState', () => {
  it('returns hint when the field is empty and no message is active', () => {
    expect(selectPrLinkHelperSlotState({ hasInput: false, message: null })).toBe('hint');
  });

  it('returns none when the field has text and no message is active', () => {
    expect(selectPrLinkHelperSlotState({ hasInput: true, message: null })).toBe('none');
  });

  it('returns invalid when the invalid message is active, regardless of input', () => {
    expect(selectPrLinkHelperSlotState({ hasInput: false, message: 'invalid' })).toBe('invalid');
    expect(selectPrLinkHelperSlotState({ hasInput: true, message: 'invalid' })).toBe('invalid');
  });

  it('returns clipboard-empty when that message is active, regardless of input', () => {
    expect(selectPrLinkHelperSlotState({ hasInput: false, message: 'clipboard-empty' })).toBe(
      'clipboard-empty'
    );
    expect(selectPrLinkHelperSlotState({ hasInput: true, message: 'clipboard-empty' })).toBe(
      'clipboard-empty'
    );
  });

  it('gives messages priority over hint and none (last-set wins at the call site)', () => {
    // Single message field — whichever the UI last set is what we select.
    expect(selectPrLinkHelperSlotState({ hasInput: false, message: 'invalid' })).toBe('invalid');
    expect(selectPrLinkHelperSlotState({ hasInput: false, message: 'clipboard-empty' })).toBe(
      'clipboard-empty'
    );
  });

  it('exports the pinned helper copy strings', () => {
    expect(PR_LINK_HELPER_INVALID_COPY).toBe('Not a GitHub pull request link');
    expect(PR_LINK_HELPER_CLIPBOARD_EMPTY_COPY).toBe('Clipboard is empty');
  });
});
