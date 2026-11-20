import { describe, expect, it } from 'vitest';

import { type SheetHeaderTopInset } from '@/lib/form-sheet';
import { presentedSheetTopClearance } from '@/lib/presented-sheet-top-inset';

const clearance = (input: {
  topInset?: SheetHeaderTopInset | undefined;
  platform?: string;
  insetTop?: number;
  surfaceOriginTop?: number | null;
  clearance?: number;
}) =>
  presentedSheetTopClearance({
    topInset: 'topInset' in input ? input.topInset : 'bottom-form-sheet',
    platform: input.platform ?? 'ios',
    insetTop: input.insetTop ?? 62,
    surfaceOriginTop: 'surfaceOriginTop' in input ? (input.surfaceOriginTop ?? null) : null,
    clearance: input.clearance ?? 0,
  });

describe('presentedSheetTopClearance', () => {
  it('covers the status-bar band above a sheet the platform presented at the window top', () => {
    // The short phone: iOS's maximum sheet height is the whole window there, so
    // the presented surface's origin converts to 0 and the whole 20pt band is
    // above the header's first row.
    expect(clearance({ insetTop: 20, surfaceOriginTop: 0 })).toBe(20);
  });

  it('adds nothing to a sheet that presented below the whole inset', () => {
    // The standard phone: the surface sits at the window inset, so its header
    // is already below the status bar and a band would be dead space.
    expect(clearance({ insetTop: 62, surfaceOriginTop: 62 })).toBe(0);
    expect(clearance({ insetTop: 62, surfaceOriginTop: 63 })).toBe(0);
  });

  it('covers only the part of the inset the presented edge leaves uncovered', () => {
    expect(clearance({ insetTop: 62, surfaceOriginTop: 24 })).toBe(38);
    expect(clearance({ insetTop: 62, surfaceOriginTop: 61.5 })).toBe(0.5);
  });

  it('keeps the clearance the surface mode already reserved when it is larger', () => {
    expect(clearance({ insetTop: 20, surfaceOriginTop: 0, clearance: 24 })).toBe(24);
    expect(clearance({ insetTop: 62, surfaceOriginTop: 24, clearance: 51.81 })).toBe(51.81);
  });

  it('never reserves more than the window inset', () => {
    // A surface converted to a negative origin (a presentation mid-animation, a
    // rounding artefact) is inside the band, not above the window.
    expect(clearance({ insetTop: 20, surfaceOriginTop: -40 })).toBe(20);
  });

  it('reserves nothing where the surface origin is unread', () => {
    // A binary that predates the native read, or a view whose window is gone.
    expect(clearance({ insetTop: 20, surfaceOriginTop: null })).toBe(0);
    expect(clearance({ insetTop: 20, surfaceOriginTop: null, clearance: 8 })).toBe(8);
  });

  it('reserves nothing for a window with no top inset', () => {
    expect(clearance({ insetTop: 0, surfaceOriginTop: 0 })).toBe(0);
  });

  it('reserves nothing on Android, whose detent cap already keeps the sheet below the bar', () => {
    // Android's own settled read owns that platform; this rule is the iOS
    // presentation offset a `UISheetPresentationController` applies.
    expect(clearance({ platform: 'android', insetTop: 51.81, surfaceOriginTop: 0 })).toBe(0);
  });

  it('reserves nothing for a mode whose surface cannot reach the window top', () => {
    for (const topInset of ['never', 'ios-page-sheet', 'always'] as const) {
      expect(clearance({ topInset, insetTop: 20, surfaceOriginTop: 0 })).toBe(0);
    }
  });

  it('covers the band for the Android named mode on iOS, where the same route is a formSheet', () => {
    // `android-window-top` names a formSheet route; on iOS the same route gets a
    // native sheet, which is presented at the window top on a short phone.
    expect(clearance({ topInset: 'android-window-top', insetTop: 20, surfaceOriginTop: 0 })).toBe(
      20
    );
  });

  it('reserves nothing for an undefined mode, which is a header with no surface', () => {
    expect(clearance({ topInset: undefined, insetTop: 20, surfaceOriginTop: 0 })).toBe(0);
  });
});
