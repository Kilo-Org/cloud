import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MONO_SCROLL_MAX_LENGTH,
  MONO_SCROLL_GESTURE_OFFSETS,
  MONO_SCROLL_TEXT_MODE_OPTIONS,
  MONO_SCROLL_VIEW_PROPS,
  nextMonoScrollHeightPin,
  prepareMonoScrollContent,
  resolveMonoScrollMaxLength,
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

  // A cap inside a surrogate pair drops the pair instead of emitting a lone high surrogate.
  it('cuts a surrogate pair whole when the cap lands inside it', () => {
    const family = '\u{1F468}\u200D\u{1F469}';
    const result = prepareMonoScrollContent(`ab${family}`, 3);
    expect(result.displayText).toBe('ab');
    expect(result.isTruncated).toBe(true);
  });

  // A ZWJ sequence whose first code unit is over budget is dropped whole, never split.
  it('drops a ZWJ family emoji whole when cut at its first code unit', () => {
    const family = '\u{1F468}\u200D\u{1F469}';
    const result = prepareMonoScrollContent(family, 1);
    expect(result.displayText).toBe('');
    expect(result.isTruncated).toBe(true);
  });

  // A regional-indicator flag cut between its two indicators is one cluster, so it is dropped.
  it('drops a flag whole when the cap lands between its two indicators', () => {
    const flag = '\u{1F1FA}\u{1F1F8}';
    const result = prepareMonoScrollContent(flag, 2);
    expect(result.displayText).toBe('');
    expect(result.isTruncated).toBe(true);
  });

  // The cluster is excluded whole: the combining acute is never left behind without its base.
  it('excludes a base letter plus combining acute as one cluster', () => {
    const result = prepareMonoScrollContent('ae\u0301', 2);
    expect(result.displayText).toBe('a');
    expect(result.isTruncated).toBe(true);
  });

  // An Indic conjunct is one cluster, so a budget below its three code units excludes it whole.
  it('excludes an Indic conjunct whole when it does not fit', () => {
    const conjunct = '\u0915\u094D\u0937';
    const result = prepareMonoScrollContent(conjunct, 2);
    expect(result.displayText).toBe('');
    expect(result.isTruncated).toBe(true);
  });

  // A cap landing exactly after a whole cluster keeps that cluster.
  it('keeps a cluster the cap ends exactly after', () => {
    const family = '\u{1F468}\u200D\u{1F469}';
    const result = prepareMonoScrollContent(`ab${family}`, 2 + family.length);
    expect(result.displayText).toBe(`ab${family}`);
    expect(result.isTruncated).toBe(false);
  });

  // Astral characters cost two code units each; a code-unit length inside the budget is untouched.
  it('leaves an astral string unchanged when its code-unit length fits the cap', () => {
    const result = prepareMonoScrollContent('\u{1F600}\u{1F600}', 4);
    expect(result.displayText).toBe('\u{1F600}\u{1F600}');
    expect(result.isTruncated).toBe(false);
  });

  // A payload longer than cap plus the cut window still cuts inside the window:
  // the cluster straddling the cap is dropped and the text before it stays.
  it('cuts inside a window of a payload longer than the cap', () => {
    const family = '\u{1F468}\u200D\u{1F469}';
    const content = 'x'.repeat(1998) + family + 'y'.repeat(3000);
    const result = prepareMonoScrollContent(content, 2000);
    expect(result.displayText).toBe('x'.repeat(1998));
    expect(result.isTruncated).toBe(true);
  });

  // A run of text is one cluster, so a cap inside it backs off to that run's end,
  // which is the last boundary before the cap — never the cap itself.
  it('backs off to the run boundary a cap lands inside', () => {
    const content = `${'x'.repeat(1900)}\u{1F468}\u200D\u{1F469}${'y'.repeat(3000)}`;
    const result = prepareMonoScrollContent(content, 1902);
    expect(result.displayText).toBe('x'.repeat(1900));
    expect(result.isTruncated).toBe(true);
  });

  // The window starts mid-value: segmenting it must not report a boundary that
  // only exists because the window began there, and the cut never emits half a pair.
  it('never ends on a lone surrogate in a payload cut mid-window', () => {
    const content = `a${'\u0301'.repeat(3000)}${'\u{1F468}\u200D\u{1F469}'.repeat(500)}`;
    const result = prepareMonoScrollContent(content, 2000);
    expect(/[\uD800-\uDBFF]$/u.test(result.displayText)).toBe(false);
    expect(result.isTruncated).toBe(true);
  });
});

describe('resolveMonoScrollMaxLength — a block is never unbounded', () => {
  it('keeps a caller budget below the default', () => {
    expect(resolveMonoScrollMaxLength(500)).toBe(500);
  });

  it('falls back to the default so a multi-megabyte output cannot be laid out', () => {
    // The default is the whole point: `undefined` used to mean "render it all",
    // and a 2 182 790-character output crashed the sheet and the app.
    expect(resolveMonoScrollMaxLength(undefined)).toBe(DEFAULT_MONO_SCROLL_MAX_LENGTH);
    expect(DEFAULT_MONO_SCROLL_MAX_LENGTH).toBeGreaterThan(0);
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
