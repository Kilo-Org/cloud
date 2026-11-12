import { describe, expect, it } from '@jest/globals';
import { capturePrependScrollPosition, restoreScrollAfterPrepend } from './older-messages-scroll';

function scrollingTranscript() {
  const layout = {
    rowTop: 40,
    rowHeight: 200,
    rowPresent: true,
    partAnchors: false,
    scrollHeight: 1000,
    viewportTop: 100,
  };
  const marker = {
    dataset: {},
    hasAttribute: () => false,
    getBoundingClientRect: () => ({ top: 0, bottom: 0, height: 0 }),
  };
  const row = {
    dataset: {},
    hasAttribute: () => false,
    getBoundingClientRect: () => {
      const top = layout.viewportTop + layout.rowTop - element.scrollTop;
      return { top, bottom: top + layout.rowHeight, height: layout.rowHeight };
    },
  };
  let currentRow = row;
  const partMarker = {
    dataset: { scrollAnchor: 'part_visible' },
    get nextElementSibling() {
      return currentRow;
    },
  };
  const element = {
    scrollTop: 60,
    get scrollHeight() {
      return layout.scrollHeight;
    },
    getBoundingClientRect: () => ({ top: layout.viewportTop, bottom: layout.viewportTop + 400 }),
    querySelectorAll: (selector: string) =>
      !layout.rowPresent
        ? []
        : selector === '[data-scroll-anchor]'
          ? layout.partAnchors
            ? [partMarker]
            : []
          : [marker, currentRow],
    contains: (child: unknown) => layout.rowPresent && child === currentRow,
  };
  return {
    element: element as unknown as HTMLElement,
    layout,
    row,
    replaceRow: () => {
      currentRow = { ...row };
    },
  };
}

describe('prepend scroll position', () => {
  it('anchors the visible row, not a zero-height grouped-message marker', () => {
    const { element, row } = scrollingTranscript();
    const position = capturePrependScrollPosition(element);
    expect(position.anchor).toEqual({ element: row, top: -20 });
  });

  it('preserves a partially visible message when history prepends', () => {
    const { element, layout, row } = scrollingTranscript();
    const position = capturePrependScrollPosition(element);
    const top = row.getBoundingClientRect().top;
    layout.rowTop += 300;
    layout.scrollHeight += 300;
    restoreScrollAfterPrepend(element, position);
    expect(element.scrollTop).toBe(360);
    expect(row.getBoundingClientRect().top).toBe(top);
  });

  it('does not count live output below the reader as prepended history', () => {
    const { element, layout, row } = scrollingTranscript();
    const position = capturePrependScrollPosition(element);
    const top = row.getBoundingClientRect().top;
    layout.rowTop += 300;
    layout.scrollHeight += 480;
    restoreScrollAfterPrepend(element, position);
    expect(element.scrollTop).toBe(360);
    expect(row.getBoundingClientRect().top).toBe(top);
  });

  it('does not scroll when only the live tail grows', () => {
    const { element, layout } = scrollingTranscript();
    const position = capturePrependScrollPosition(element);
    layout.scrollHeight += 180;
    restoreScrollAfterPrepend(element, position);
    expect(element.scrollTop).toBe(60);
  });

  it('does not apply a second correction after the browser anchors the row', () => {
    const { element, layout } = scrollingTranscript();
    const position = capturePrependScrollPosition(element);
    layout.rowTop += 300;
    layout.scrollHeight += 300;
    element.scrollTop += 300;
    restoreScrollAfterPrepend(element, position);
    restoreScrollAfterPrepend(element, position);
    expect(element.scrollTop).toBe(360);
  });

  it('restores again when the transcript rows commit after the loading state', () => {
    const { element, layout } = scrollingTranscript();
    const position = capturePrependScrollPosition(element);
    restoreScrollAfterPrepend(element, position);
    layout.rowTop += 300;
    layout.scrollHeight += 300;
    restoreScrollAfterPrepend(element, position);
    expect(element.scrollTop).toBe(360);
  });

  it('keeps the same part visible after prepending regroups its assistant row', () => {
    const { element, layout, replaceRow } = scrollingTranscript();
    layout.partAnchors = true;
    const position = capturePrependScrollPosition(element);
    replaceRow();
    layout.rowTop += 300;
    layout.scrollHeight += 480;
    restoreScrollAfterPrepend(element, position);
    expect(element.scrollTop).toBe(360);
  });

  it('measures the row relative to the viewport when the viewport itself moves', () => {
    const { element, layout } = scrollingTranscript();
    const position = capturePrependScrollPosition(element);
    layout.viewportTop += 30;
    restoreScrollAfterPrepend(element, position);
    expect(element.scrollTop).toBe(60);
  });

  it('uses the captured scroll position if the anchored row was replaced', () => {
    const { element, layout } = scrollingTranscript();
    const position = capturePrependScrollPosition(element);
    layout.rowPresent = false;
    layout.scrollHeight += 300;
    element.scrollTop += 300;
    restoreScrollAfterPrepend(element, position);
    expect(element.scrollTop).toBe(360);
  });

  it('uses a height snapshot when no visible message can be anchored', () => {
    const { element, layout } = scrollingTranscript();
    layout.rowPresent = false;
    const position = capturePrependScrollPosition(element);
    layout.scrollHeight += 300;
    restoreScrollAfterPrepend(element, position);
    expect(element.scrollTop).toBe(360);
  });
});
