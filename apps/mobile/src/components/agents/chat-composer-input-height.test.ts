import { describe, expect, it } from 'vitest';

import {
  clampComposerInputHeight,
  resolveComposerHeightOnTextChange,
  resolveComposerInputHeight,
  shouldEnableComposerInputScroll,
} from './chat-composer-input-height';

const MIN = 44;
const MAX = 124;

describe('clampComposerInputHeight', () => {
  it('clamps growth to min and max and rounds fractional heights up', () => {
    expect(clampComposerInputHeight(20, { minHeight: MIN, maxHeight: MAX })).toBe(MIN);
    expect(clampComposerInputHeight(64.1, { minHeight: MIN, maxHeight: MAX })).toBe(65);
    expect(clampComposerInputHeight(200, { minHeight: MIN, maxHeight: MAX })).toBe(MAX);
    expect(clampComposerInputHeight(MIN, { minHeight: MIN, maxHeight: MAX })).toBe(MIN);
    expect(clampComposerInputHeight(MAX, { minHeight: MIN, maxHeight: MAX })).toBe(MAX);
  });
});

describe('resolveComposerInputHeight', () => {
  it('always returns minHeight when the draft is empty (stale after-clear event)', () => {
    expect(
      resolveComposerInputHeight({
        draftLength: 0,
        contentHeight: 200,
        minHeight: MIN,
        maxHeight: MAX,
      })
    ).toBe(MIN);
  });

  it('clamps non-empty drafts to the latest contentSize within min/max', () => {
    expect(
      resolveComposerInputHeight({
        draftLength: 10,
        contentHeight: 64,
        minHeight: MIN,
        maxHeight: MAX,
      })
    ).toBe(64);
    expect(
      resolveComposerInputHeight({
        draftLength: 10,
        contentHeight: 84.2,
        minHeight: MIN,
        maxHeight: MAX,
      })
    ).toBe(85);
    expect(
      resolveComposerInputHeight({
        draftLength: 500,
        contentHeight: 300,
        minHeight: MIN,
        maxHeight: MAX,
      })
    ).toBe(MAX);
  });

  it('resolves a shrinking draft to the latest smaller contentSize', () => {
    const tall = resolveComposerInputHeight({
      draftLength: 80,
      contentHeight: 104,
      minHeight: MIN,
      maxHeight: MAX,
    });
    const short = resolveComposerInputHeight({
      draftLength: 5,
      contentHeight: 44,
      minHeight: MIN,
      maxHeight: MAX,
    });
    expect(tall).toBe(104);
    expect(short).toBe(MIN);
    expect(short).toBeLessThan(tall);
  });
});

describe('shouldEnableComposerInputScroll', () => {
  it('is true at or above max and false below', () => {
    expect(shouldEnableComposerInputScroll(MAX, MAX)).toBe(true);
    expect(shouldEnableComposerInputScroll(MAX + 1, MAX)).toBe(true);
    expect(shouldEnableComposerInputScroll(MAX - 1, MAX)).toBe(false);
    expect(shouldEnableComposerInputScroll(MIN, MAX)).toBe(false);
  });
});

describe('resolveComposerHeightOnTextChange', () => {
  it('returns minHeight when the next draft is empty', () => {
    expect(
      resolveComposerHeightOnTextChange({
        previousDraftLength: 12,
        nextDraftLength: 0,
        lastContentHeight: 104,
        minHeight: MIN,
        maxHeight: MAX,
      })
    ).toBe(MIN);
  });

  it('repairs empty→non-empty using the last measured content height (voice ordering)', () => {
    expect(
      resolveComposerHeightOnTextChange({
        previousDraftLength: 0,
        nextDraftLength: 40,
        lastContentHeight: 84,
        minHeight: MIN,
        maxHeight: MAX,
      })
    ).toBe(84);
    expect(
      resolveComposerHeightOnTextChange({
        previousDraftLength: 0,
        nextDraftLength: 40,
        lastContentHeight: 300,
        minHeight: MIN,
        maxHeight: MAX,
      })
    ).toBe(MAX);
  });

  it('returns null when there is no height decision to make (leave to native event)', () => {
    expect(
      resolveComposerHeightOnTextChange({
        previousDraftLength: 5,
        nextDraftLength: 6,
        lastContentHeight: 64,
        minHeight: MIN,
        maxHeight: MAX,
      })
    ).toBeNull();
    expect(
      resolveComposerHeightOnTextChange({
        previousDraftLength: 0,
        nextDraftLength: 3,
        lastContentHeight: null,
        minHeight: MIN,
        maxHeight: MAX,
      })
    ).toBeNull();
  });
});
