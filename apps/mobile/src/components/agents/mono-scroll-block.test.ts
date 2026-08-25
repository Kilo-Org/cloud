import { describe, expect, it } from 'vitest';

import {
  MONO_SCROLL_GESTURE_OFFSETS,
  MONO_SCROLL_TEXT_MODE_OPTIONS,
  MONO_SCROLL_VIEW_PROPS,
  nextMonoScrollHeightPin,
  prepareMonoScrollContent,
  resolveMonoScrollPinnedHeight,
} from './mono-scroll-block-model';

describe('prepareMonoScrollContent', () => {
  it('returns the full string when under the cap and does not mark truncated', () => {
    const content = 'short output';
    const result = prepareMonoScrollContent(content, 2000);
    expect(result.displayText).toBe(content);
    expect(result.isTruncated).toBe(false);
  });

  it('returns the full string when maxLength is omitted', () => {
    const content = 'x'.repeat(5000);
    const result = prepareMonoScrollContent(content);
    expect(result.displayText).toBe(content);
    expect(result.isTruncated).toBe(false);
  });

  it('slices at the cap and marks truncated without mutating the input', () => {
    const content = 'abcdefghij';
    const result = prepareMonoScrollContent(content, 4);
    expect(result.displayText).toBe('abcd');
    expect(result.isTruncated).toBe(true);
    expect(content).toBe('abcdefghij');
  });

  it('does not truncate when length equals maxLength', () => {
    const content = 'abcd';
    const result = prepareMonoScrollContent(content, 4);
    expect(result.displayText).toBe(content);
    expect(result.isTruncated).toBe(false);
  });

  it('does not append an ellipsis — the Truncated marker is the affordance', () => {
    const result = prepareMonoScrollContent('hello world', 5);
    expect(result.displayText).toBe('hello');
    expect(result.displayText.endsWith('\u2026')).toBe(false);
  });
});

describe('height pin — content growth must remeasure', () => {
  it('applies pinned height only while pin text matches display text', () => {
    const pin = { text: 'line1', height: 16 };
    expect(resolveMonoScrollPinnedHeight(pin, 'line1')).toBe(16);
    expect(resolveMonoScrollPinnedHeight(pin, 'line1\nline2')).toBeUndefined();
    expect(resolveMonoScrollPinnedHeight(undefined, 'line1')).toBeUndefined();
  });

  it('allows height to grow after display text changes (stale pin ignored)', () => {
    const shortPin = nextMonoScrollHeightPin(undefined, 'short', 16);
    expect(resolveMonoScrollPinnedHeight(shortPin, 'short')).toBe(16);

    // Text grew (e.g. preparation-group outputTail while expanded) — drop pin.
    const grownText = 'short\nsecond line\nthird';
    expect(resolveMonoScrollPinnedHeight(shortPin, grownText)).toBeUndefined();

    const grownPin = nextMonoScrollHeightPin(shortPin, grownText, 48);
    expect(grownPin).toEqual({ text: grownText, height: 48 });
    expect(resolveMonoScrollPinnedHeight(grownPin, grownText)).toBe(48);
  });

  it('keeps the previous pin object when text and height are unchanged', () => {
    const pin = nextMonoScrollHeightPin(undefined, 'stable', 20);
    const again = nextMonoScrollHeightPin(pin, 'stable', 20.2);
    expect(again).toBe(pin);
  });
});

describe('MONO_SCROLL_TEXT_MODE_OPTIONS — segmented-control order matches the sheet default', () => {
  it('is exactly wrap then scroll, with stable label keys', () => {
    expect(MONO_SCROLL_TEXT_MODE_OPTIONS).toEqual([
      { value: 'wrap', labelKey: 'monoScrollBlock.wrap' },
      { value: 'scroll', labelKey: 'monoScrollBlock.scroll' },
    ]);
  });
});

describe('MONO_SCROLL_VIEW_PROPS — overflow affordance and nested delivery', () => {
  it('shows the horizontal scroll indicator (C-a overflow affordance)', () => {
    expect(MONO_SCROLL_VIEW_PROPS.showsHorizontalScrollIndicator).toBe(true);
  });

  it('is a horizontal scroller with nested / directional lock for list coexistence', () => {
    expect(MONO_SCROLL_VIEW_PROPS.horizontal).toBe(true);
    expect(MONO_SCROLL_VIEW_PROPS.directionalLockEnabled).toBe(true);
    expect(MONO_SCROLL_VIEW_PROPS.nestedScrollEnabled).toBe(true);
    expect(MONO_SCROLL_VIEW_PROPS.canCancelContentTouches).toBe(true);
  });

  it('uses RNGH directional activation so horizontal pans reach the block', () => {
    expect(MONO_SCROLL_GESTURE_OFFSETS.activeOffsetX).toEqual([-10, 10]);
    expect(MONO_SCROLL_GESTURE_OFFSETS.failOffsetY).toEqual([-10, 10]);
    expect(MONO_SCROLL_VIEW_PROPS.activeOffsetX).toEqual([-10, 10]);
    expect(MONO_SCROLL_VIEW_PROPS.failOffsetY).toEqual([-10, 10]);
  });
});
