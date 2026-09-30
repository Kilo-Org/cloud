import { describe, expect, it, vi } from 'vitest';

import { estimateSessionListHeaderActionsWidth } from './session-list-header-actions-width';

// The module reaches `@/lib/rtl-text` for the header label's script detection,
// which imports `I18nManager` from react-native. The pure project runs under
// Node with no RN transform, so stub the one export the module reads (the same
// stub `rtl-text.test.ts` uses).
vi.mock('react-native', () => ({ I18nManager: { isRTL: false } }));

describe('estimateSessionListHeaderActionsWidth', () => {
  const english = { sectionLabel: 'LIVE NOW', historyLabel: 'PAST SESSIONS', showFilter: true };
  const croatian = {
    sectionLabel: 'TRENUTAČNO AKTIVNO',
    historyLabel: 'PRETHODNE SESIJE',
    showFilter: true,
  };

  it('reserves enough width for the Croatian Agents row to reflow on a phone', () => {
    // `shouldStackHeaderActions` reserves this against the 44dp gutter and the
    // 12dp heading gap: 390 - 44 - 12 - estimate < 120 drops the row beneath the
    // title instead of breaking "Agenti" mid-word (agents-header-hr-20260929).
    expect(estimateSessionListHeaderActionsWidth(croatian)).toBeGreaterThan(214);
  });

  it('grows with a longer catalog and with the system font scale', () => {
    expect(estimateSessionListHeaderActionsWidth(croatian)).toBeGreaterThan(
      estimateSessionListHeaderActionsWidth(english)
    );
    expect(estimateSessionListHeaderActionsWidth({ ...english, fontScale: 2 })).toBeGreaterThan(
      estimateSessionListHeaderActionsWidth(english)
    );
  });

  it('counts the filter button and its gap only when the list can be filtered', () => {
    const withoutFilter = estimateSessionListHeaderActionsWidth({ ...english, showFilter: false });
    const withFilter = estimateSessionListHeaderActionsWidth(english);
    // The 36dp button plus one 14dp `gap-4`.
    expect(withFilter - withoutFilter).toBe(50);
  });

  it('drops the letterspacing the RTL display treatment drops, per label script', () => {
    // `Text` resets tracking for RTL-script copy in an RTL interface, so a
    // Hebrew section label narrows the estimate there; the Latin history label
    // keeps its tracking in either direction (see the next case).
    const hebrew = { sectionLabel: 'סוכנים', historyLabel: 'PAST SESSIONS', showFilter: true };
    expect(estimateSessionListHeaderActionsWidth({ ...hebrew, isRTL: true })).toBeLessThan(
      estimateSessionListHeaderActionsWidth(hebrew)
    );
  });

  it('keeps a Latin label’s letterspacing in an RTL interface', () => {
    // The reset follows the label's script, not the interface direction: Latin
    // copy keeps `tracking-[1.5px]` in an RTL interface, so the estimate must
    // stay an upper bound instead of shrinking under the rendered cluster.
    expect(estimateSessionListHeaderActionsWidth({ ...english, isRTL: true })).toBe(
      estimateSessionListHeaderActionsWidth(english)
    );
  });

  it('drops the letterspacing for a joined script in either direction', () => {
    const joined = { sectionLabel: 'الجلسات', historyLabel: 'الجلسات', showFilter: true };
    expect(estimateSessionListHeaderActionsWidth(joined)).toBe(
      estimateSessionListHeaderActionsWidth({ ...joined, isRTL: true })
    );
  });
});
