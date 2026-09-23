import { describe, expect, it } from 'vitest';

import {
  getBottomReservation,
  getCenteredStateBand,
  getCenteredStateLayout,
  getStateSurfaceInsets,
  intersectStateFrames,
  isShortViewport,
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

  it('balances a short sheet when exact centering would crowd the header', () => {
    const layout = getCenteredStateLayout({
      surface: { top: 0, bottom: 320 },
      viewport: { top: 60, bottom: 320 },
      contentHeight: 180,
    });
    expect(layout.paddingTop).toBe(40);
    expect(60 + layout.paddingTop + 90).toBe(190);
    expect(layout.paddingBottom).toBe(40);
  });

  it('keeps content below a tall header when the target is obstructed', () => {
    const layout = getCenteredStateLayout({
      surface: { top: 0, bottom: 800 },
      viewport: { top: 450, bottom: 800 },
      contentHeight: 200,
    });
    expect(layout.paddingTop).toBe(48);
  });

  it('keeps content above an overlay without counting its inset twice', () => {
    const layout = getCenteredStateLayout({
      surface: { top: 0, bottom: 800 },
      viewport: { top: 100, bottom: 720 },
      contentHeight: 600,
      bottomInset: 80,
    });
    expect(layout.paddingTop).toBe(10);
    expect(layout.paddingBottom).toBe(10);
  });

  it.each([
    {
      name: 'Android half-sheet',
      surface: { top: 320, bottom: 640 },
      viewport: { top: 384, bottom: 640 },
      contentHeight: 177.5,
      paddingTop: 39.25,
    },
    {
      name: 'iOS language picker above the keyboard',
      surface: { top: 30, bottom: 435 },
      viewport: { top: 155, bottom: 667 },
      contentHeight: 109,
      paddingTop: 48,
    },
    {
      name: 'Android language picker above the keyboard',
      surface: { top: 48, bottom: 340 },
      viewport: { top: 173, bottom: 640 },
      contentHeight: 108.5,
      paddingTop: 29.25,
    },
  ])('adds bounded clearance for the $name', ({ surface, viewport, contentHeight, paddingTop }) => {
    const layout = getCenteredStateLayout({ surface, viewport, contentHeight });
    expect(layout.paddingTop).toBe(paddingTop);
    expect(viewport.top + layout.paddingTop + contentHeight).toBeLessThanOrEqual(surface.bottom);
  });

  it('does not force overflow when content exactly fills the available body', () => {
    expect(
      getCenteredStateLayout({
        surface: { top: 0, bottom: 400 },
        viewport: { top: 100, bottom: 400 },
        contentHeight: 300,
      })
    ).toEqual({ minHeight: 300, paddingTop: 0, paddingBottom: 0 });
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

describe('isShortViewport', () => {
  it('reads a phone in landscape as short and the same phone in portrait as tall', () => {
    expect(isShortViewport(914, 411)).toBe(true);
    expect(isShortViewport(411, 914)).toBe(false);
  });

  it('reads a tablet in landscape as tall, so the state keeps its full stack', () => {
    // Wide but not short: the band there is taller than the whole stack.
    expect(isShortViewport(1024, 768)).toBe(false);
    // A 600dp-short-edge tablet is Android's smallest (the `sw600dp`
    // qualifier, the 1024x600 emulator). It is wide but still a tablet: its
    // band is ~384dp against the ~167dp stack, so it keeps the full stack too.
    expect(isShortViewport(1024, 600)).toBe(false);
  });

  it('reads a square window as tall, so the state keeps its full stack', () => {
    expect(isShortViewport(500, 500)).toBe(false);
  });

  it('reads an unavailable dimension as tall', () => {
    // A partial platform mock (the mounted-test harnesses) omits a dimension;
    // treating it as short would silently change every state's layout there.
    expect(isShortViewport(undefined as unknown as number, 844)).toBe(false);
    expect(isShortViewport(390, Number.NaN)).toBe(false);
  });
});

describe('getCenteredStateBand', () => {
  it('ends the band at the reserved bottom inset, above the tab bar', () => {
    // The e8 geometry: a 540pt-tall landscape window, the Agents body starting
    // below its header at 277pt, and a 117pt tab bar band. The empty state has
    // 146pt to be centered in — not the 263pt of the viewport.
    expect(
      getCenteredStateBand({
        surface: { top: 0, bottom: 540 },
        viewport: { top: 277, bottom: 540 },
        bottomInset: 117,
      })
    ).toEqual({ top: 277, bottom: 423, band: 146 });
  });

  it('clips the band to the visible viewport', () => {
    expect(
      getCenteredStateBand({
        surface: { top: 0, bottom: 540 },
        viewport: { top: 277, bottom: 400 },
        bottomInset: 117,
      })
    ).toEqual({ top: 277, bottom: 400, band: 123 });
  });

  it('reserves the top inset as well', () => {
    expect(
      getCenteredStateBand({
        surface: { top: 0, bottom: 800 },
        viewport: { top: 0, bottom: 800 },
        topInset: 60,
        bottomInset: 100,
      })
    ).toEqual({ top: 60, bottom: 700, band: 640 });
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

describe('getBottomReservation', () => {
  it('raises an inherited reserve with the passed inset, never shrinking it', () => {
    expect(getBottomReservation({ inherited: 97, bottomInset: 81 })).toBe(97);
    expect(getBottomReservation({ inherited: 60, bottomInset: 81 })).toBe(81);
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
