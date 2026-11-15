import { describe, expect, it } from 'vitest';

import { CHAT_TITLE_NOTICE_GAP_DP, titleKeepsNotice } from './chat-title-notice';

// The widths the design gate measured on the model chat header at font scale 1:
// the title "Chat" is 33.52 dp, the BETA pill 41.52 dp, and the header slot
// (ScreenHeader's `min-w-0 flex-1` heading) is 76.19 dp on the 360 dp compact
// cell and 127.62 dp on the 411 dp cell.
const CHAT = 33.52;
const BETA = 41.52;
const COMPACT_SLOT = 76.19;
const BASE_SLOT = 127.62;

describe('titleKeepsNotice', () => {
  it('drops the notice on the compact header rather than truncating the title', () => {
    expect(titleKeepsNotice({ slot: COMPACT_SLOT, title: CHAT, notice: BETA })).toBe(false);
  });

  it('keeps the notice where the title and the notice fit together', () => {
    expect(titleKeepsNotice({ slot: BASE_SLOT, title: CHAT, notice: BETA })).toBe(true);
  });

  it('counts the gap between the two against the slot', () => {
    const exact = CHAT + CHAT_TITLE_NOTICE_GAP_DP + BETA;
    expect(titleKeepsNotice({ slot: exact, title: CHAT, notice: BETA })).toBe(false);
    expect(titleKeepsNotice({ slot: exact + 1, title: CHAT, notice: BETA })).toBe(true);
  });

  it('drops the notice for a title that fills the slot on its own', () => {
    // A title longer than the slot reports the slot's width, which never fits
    // beside the notice: the title keeps its own room and truncates there.
    const longTitle = 400;
    expect(titleKeepsNotice({ slot: BASE_SLOT, title: BASE_SLOT, notice: BETA })).toBe(false);
    expect(titleKeepsNotice({ slot: BASE_SLOT, title: longTitle, notice: BETA })).toBe(false);
  });

  it('treats an unmeasured notice as no notice at all', () => {
    expect(titleKeepsNotice({ slot: BASE_SLOT, title: CHAT, notice: 0 })).toBe(true);
    expect(titleKeepsNotice({ slot: COMPACT_SLOT, title: COMPACT_SLOT, notice: 0 })).toBe(false);
  });
});
