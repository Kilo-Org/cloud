import { describe, expect, it } from 'vitest';

import {
  getCenteredStateLayout,
  getStateSurfaceInsets,
  intersectStateFrames,
} from './centered-state-layout';

describe('getCenteredStateLayout', () => {
  it.each([
    { title: 'no header or footer', viewport: { top: 0, bottom: 800 } },
    { title: 'header only', viewport: { top: 100, bottom: 800 } },
    { title: 'footer only', viewport: { top: 0, bottom: 700 } },
    { title: 'unequal header and footer', viewport: { top: 100, bottom: 760 } },
    { title: 'equal header and footer', viewport: { top: 100, bottom: 700 } },
  ])('centers on the surface with $title', ({ viewport }) => {
    const layout = getCenteredStateLayout({
      surface: { top: 0, bottom: 800 },
      viewport,
      contentHeight: 200,
    });
    expect(viewport.top + layout.paddingTop + 100).toBe(400);
    expect(layout.minHeight).toBe(viewport.bottom - viewport.top);
  });

  it('centers inside a sheet rather than the application window', () => {
    const layout = getCenteredStateLayout({
      surface: { top: 300, bottom: 800 },
      viewport: { top: 380, bottom: 800 },
      contentHeight: 100,
    });
    expect(380 + layout.paddingTop + 50).toBe(550);
  });

  it('does not shift a short-sheet state when it fits at the exact center', () => {
    const layout = getCenteredStateLayout({
      surface: { top: 0, bottom: 320 },
      viewport: { top: 60, bottom: 320 },
      contentHeight: 180,
    });
    expect(layout.paddingTop).toBe(10);
    expect(60 + layout.paddingTop + 90).toBe(160);
  });

  it('keeps content below a tall header when the target is obstructed', () => {
    const layout = getCenteredStateLayout({
      surface: { top: 0, bottom: 800 },
      viewport: { top: 450, bottom: 800 },
      contentHeight: 200,
    });
    expect(layout.paddingTop).toBe(0);
  });

  it('keeps content above an overlay without counting its inset twice', () => {
    const layout = getCenteredStateLayout({
      surface: { top: 0, bottom: 800 },
      viewport: { top: 100, bottom: 720 },
      contentHeight: 600,
      bottomInset: 80,
    });
    expect(layout.paddingTop).toBe(0);
    expect(layout.paddingBottom).toBe(20);
  });

  it('gives tall content normal scrollable padding rather than a negative offset', () => {
    const layout = getCenteredStateLayout({
      surface: { top: 0, bottom: 400 },
      viewport: { top: 100, bottom: 400 },
      contentHeight: 700,
      bottomInset: 40,
    });
    expect(layout).toEqual({ minHeight: 300, paddingTop: 16, paddingBottom: 56 });
  });

  it.each([false, true])(
    'keeps a flow footer reachable with native fill %s',
    nativeViewportFillsSurface => {
      const viewport = { top: 80, bottom: 420 };
      const contentHeight = 700;
      const layout = getCenteredStateLayout({
        surface: { top: 0, bottom: 500 },
        viewport,
        contentHeight,
        nativeViewportFillsSurface,
      });
      const nativeHeight = nativeViewportFillsSurface ? 420 : 340;
      const scrollRange = layout.paddingTop + contentHeight + layout.paddingBottom - nativeHeight;
      expect(layout.minHeight).toBe(nativeHeight);
      expect(layout.paddingBottom).toBe(nativeViewportFillsSurface ? 96 : 16);
      expect(viewport.top + layout.paddingTop + contentHeight - scrollRange).toBe(404);
    }
  );

  it.each([0, 80])('preserves a short state above a flow footer with inset %s', bottomInset => {
    const layout = getCenteredStateLayout({
      surface: { top: 300, bottom: 800 },
      viewport: { top: 380, bottom: 720 },
      contentHeight: 120,
      bottomInset,
      nativeViewportFillsSurface: true,
    });
    expect(layout).toEqual({ minHeight: 420, paddingTop: 110, paddingBottom: 190 });
    expect(380 + layout.paddingTop + 60).toBe(550);
  });

  it('does not add a second clearance for an overlay footer', () => {
    const layout = getCenteredStateLayout({
      surface: { top: 0, bottom: 500 },
      viewport: { top: 80, bottom: 500 },
      contentHeight: 700,
      bottomInset: 80,
      nativeViewportFillsSurface: true,
    });
    expect(layout).toEqual({ minHeight: 420, paddingTop: 16, paddingBottom: 96 });
  });

  it('fills the sheet without adding clearance when there is no footer', () => {
    const layout = getCenteredStateLayout({
      surface: { top: 300, bottom: 800 },
      viewport: { top: 380, bottom: 800 },
      contentHeight: 120,
      nativeViewportFillsSurface: true,
    });
    expect(layout).toEqual({ minHeight: 420, paddingTop: 110, paddingBottom: 190 });
  });

  it('uses the visible viewport after keyboard avoidance', () => {
    const layout = getCenteredStateLayout({
      surface: { top: 0, bottom: 500 },
      viewport: { top: 80, bottom: 440 },
      contentHeight: 120,
    });
    expect(80 + layout.paddingTop + 60).toBe(250);
  });

  it('keeps a clipped native sheet within its visible surface', () => {
    const layout = getCenteredStateLayout({
      surface: { top: 400, bottom: 800 },
      viewport: { top: 480, bottom: 1100 },
      contentHeight: 120,
    });
    expect(480 + layout.paddingTop + 60).toBe(600);
    expect(layout.paddingBottom).toBe(440);
  });
});

describe('native keyboard clipping', () => {
  it('keeps the native scroll extent while centering above the keyboard', () => {
    const layout = getCenteredStateLayout({
      surface: { top: 0, bottom: 400 },
      viewport: { top: 80, bottom: 620 },
      contentHeight: 120,
      nativeViewportFillsSurface: true,
      nativeViewportBottom: 700,
    });
    expect(layout).toEqual({ minHeight: 620, paddingTop: 60, paddingBottom: 440 });
    expect(80 + layout.paddingTop + 60).toBe(200);
  });

  it('keeps a long state action above the keyboard at the end of scrolling', () => {
    const layout = getCenteredStateLayout({
      surface: { top: 0, bottom: 400 },
      viewport: { top: 80, bottom: 620 },
      contentHeight: 800,
      nativeViewportFillsSurface: true,
      nativeViewportBottom: 700,
    });
    const scrollRange = layout.paddingTop + 800 + layout.paddingBottom - layout.minHeight;
    expect(80 + layout.paddingTop + 800 - scrollRange).toBe(384);
  });
});

describe('getStateSurfaceInsets', () => {
  it('does not reserve a tab bar that is behind the keyboard', () => {
    expect(
      getStateSurfaceInsets({
        surface: { top: 0, bottom: 500 },
        bounds: { top: 0, bottom: 800 },
        top: 60,
        bottom: 100,
      })
    ).toEqual({ topInset: 60, bottomInset: 0 });
  });

  it('reserves a footer that moves with a resized root', () => {
    expect(
      getStateSurfaceInsets({
        surface: { top: 0, bottom: 500 },
        bounds: { top: 0, bottom: 500 },
        top: 60,
        bottom: 100,
      })
    ).toEqual({ topInset: 60, bottomInset: 100 });
  });

  it('does not subtract an already-clipped safe area twice', () => {
    expect(
      getStateSurfaceInsets({
        surface: { top: 40, bottom: 760 },
        bounds: { top: 0, bottom: 800 },
        top: 40,
        bottom: 40,
      })
    ).toEqual({ topInset: 0, bottomInset: 0 });
  });
});

describe('intersectStateFrames', () => {
  it('clips an oversized sheet to its containing window', () => {
    expect(intersectStateFrames({ top: 400, bottom: 1200 }, { top: 0, bottom: 800 })).toEqual({
      top: 400,
      bottom: 800,
    });
  });

  it('returns a zero-height frame for a surface outside the window', () => {
    expect(intersectStateFrames({ top: 900, bottom: 1200 }, { top: 0, bottom: 800 })).toEqual({
      top: 800,
      bottom: 800,
    });
  });
});
