import { describe, expect, it } from '@jest/globals';
import { capturePrependScrollPosition, restoreScrollAfterPrepend } from './older-messages-scroll';

function scrollingTranscript() {
  const layout = {
    rowTop: 40,
    rowHeight: 200,
    rowPresent: true,
    messageId: 'msg_visible',
    regrouped: false,
    partAnchors: false,
    collapsedGroup: false,
    groupPartIds: ['part_first', 'part_visible'],
    mergedHeight: 0,
    scrollHeight: 1000,
    viewportTop: 100,
  };
  const marker = {
    dataset: {},
    getAttribute: () => null,
    hasAttribute: () => false,
    getBoundingClientRect: () => ({ top: 0, bottom: 0, height: 0 }),
  };
  const row = {
    dataset: {},
    getAttribute: (key: string) => (key === 'data-message-id' ? layout.messageId : null),
    closest: () => null,
    hasAttribute: () => false,
    getBoundingClientRect: () => {
      const top = layout.viewportTop + layout.rowTop - element.scrollTop;
      return { top, bottom: top + layout.rowHeight, height: layout.rowHeight };
    },
  };
  let currentRow = row;
  const groupHeader = {
    hasAttribute: () => false,
    getBoundingClientRect: () => {
      const top = layout.viewportTop + layout.rowTop + layout.mergedHeight - element.scrollTop;
      return { top, bottom: top + 44, height: 44 };
    },
  };
  let currentHeader = groupHeader;
  const partMarker = {
    dataset: { scrollAnchor: 'part_visible' },
    getAttribute: (key: string) => (key === 'data-scroll-anchor' ? 'part_visible' : null),
    get nextElementSibling() {
      return currentRow;
    },
    closest: () => null,
  };
  const groupMarkers = () =>
    layout.groupPartIds.map(id => ({
      getAttribute: (key: string) => (key === 'data-scroll-anchor' ? id : null),
      nextElementSibling: null,
      closest: () => currentHeader,
    }));
  const groupedMessageMarker = {
    ...marker,
    getAttribute: (key: string) => (key === 'data-message-id' ? 'msg_visible' : null),
    closest: () => currentRow,
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
          ? layout.collapsedGroup
            ? groupMarkers()
            : layout.partAnchors
              ? [partMarker]
              : []
          : [marker, currentRow, ...(layout.regrouped ? [groupedMessageMarker] : [])],
    contains: (child: unknown) =>
      layout.rowPresent && (child === currentRow || child === currentHeader),
  };
  return {
    element: element as unknown as HTMLElement,
    layout,
    row,
    get groupHeader() {
      return currentHeader;
    },
    replaceRow: () => {
      currentRow = { ...row };
      currentHeader = { ...groupHeader };
    },
  };
}

describe('prepend scroll position', () => {
  it('anchors the visible row, not a zero-height grouped-message marker', () => {
    const { element, row } = scrollingTranscript();
    const position = capturePrependScrollPosition(element);
    expect(position.anchor).toEqual({
      element: row,
      top: -20,
      key: 'data-message-id',
      value: 'msg_visible',
    });
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

  it.each([false, true])(
    'follows a replaced message row without counting live output (browser anchoring: %s)',
    browserAnchored => {
      const { element, layout, replaceRow } = scrollingTranscript();
      const position = capturePrependScrollPosition(element);
      replaceRow();
      layout.rowTop += 300;
      layout.scrollHeight += 480;
      if (browserAnchored) element.scrollTop += 300;
      restoreScrollAfterPrepend(element, position);
      restoreScrollAfterPrepend(element, position);
      expect(element.scrollTop).toBe(360);
    }
  );

  it('follows the retained message marker when a regrouped row has no internal offset', () => {
    const { element, layout, replaceRow } = scrollingTranscript();
    const position = capturePrependScrollPosition(element);
    replaceRow();
    layout.messageId = 'msg_older';
    layout.regrouped = true;
    layout.rowTop += 300;
    layout.scrollHeight += 480;
    element.scrollTop += 300;
    restoreScrollAfterPrepend(element, position);
    restoreScrollAfterPrepend(element, position);
    expect(element.scrollTop).toBe(360);
  });

  it.each([false, true])(
    'keeps a collapsed header fixed when merged content precedes it (browser anchoring: %s)',
    browserAnchored => {
      const transcript = scrollingTranscript();
      const { element, layout, replaceRow } = transcript;
      layout.collapsedGroup = true;
      const top = transcript.groupHeader.getBoundingClientRect().top;
      const position = capturePrependScrollPosition(element);
      expect(position.anchor).toMatchObject({
        element: transcript.groupHeader,
        key: 'data-scroll-anchor',
        value: 'part_first',
      });
      replaceRow();
      layout.messageId = 'msg_older';
      layout.regrouped = true;
      layout.groupPartIds.unshift('part_older');
      layout.rowTop += 300;
      layout.mergedHeight = 180;
      layout.scrollHeight += 660;
      if (browserAnchored) element.scrollTop += 480;
      restoreScrollAfterPrepend(element, position);
      restoreScrollAfterPrepend(element, position);
      expect(element.scrollTop).toBe(540);
      expect(transcript.groupHeader.getBoundingClientRect().top).toBe(top);
    }
  );

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
