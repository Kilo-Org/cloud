/* eslint-disable max-lines -- the band, inset, pending-placement, and short-viewport contracts all read the same geometry helpers, so they stay in one suite. */
import { describe, expect, it } from 'vitest';

import {
  getBottomReservation,
  getCenteredStateBand,
  getCenteredStateBandStyle,
  getCenteredStateLayout,
  getPendingCenteredStateStyle,
  getStateSurfaceInsets,
  intersectStateFrames,
  isShortViewport,
} from './centered-state-layout';

/**
 * Where the layout engine draws the content inside a scroll container that
 * carries these paddings: centered in the slack when the content is shorter
 * than the container, and from the top padding when it is taller.
 */
function renderedTop(
  layout: { minHeight: number; paddingTop: number; paddingBottom: number },
  viewportTop: number,
  contentHeight: number
) {
  const container = Math.max(
    layout.minHeight,
    layout.paddingTop + contentHeight + layout.paddingBottom
  );
  const inside =
    layout.paddingTop + (container - layout.paddingTop - layout.paddingBottom - contentHeight) / 2;
  return viewportTop + inside;
}

describe('getCenteredStateLayout', () => {
  it.each([
    { title: 'no header or footer', viewport: { top: 0, bottom: 800 } },
    { title: 'header only', viewport: { top: 100, bottom: 800 } },
    { title: 'footer only', viewport: { top: 0, bottom: 700 } },
    { title: 'unequal header and footer', viewport: { top: 100, bottom: 760 } },
    { title: 'equal header and footer', viewport: { top: 100, bottom: 700 } },
  ])('centers in the band the scroller shows with $title', ({ viewport }) => {
    const layout = getCenteredStateLayout({
      window: { top: 0, bottom: 800 },
      viewport,
      contentHeight: 200,
    });
    expect(renderedTop(layout, viewport.top, 200) + 100).toBe((viewport.top + viewport.bottom) / 2);
    expect(layout.minHeight).toBe(viewport.bottom - viewport.top);
  });

  it('centers inside a sheet scroller inside the window', () => {
    const layout = getCenteredStateLayout({
      window: { top: 0, bottom: 800 },
      viewport: { top: 380, bottom: 800 },
      contentHeight: 100,
    });
    expect(renderedTop(layout, 380, 100) + 50).toBe(590);
  });

  it('centers a short sheet inside its band', () => {
    const layout = getCenteredStateLayout({
      window: { top: 0, bottom: 320 },
      viewport: { top: 60, bottom: 320 },
      contentHeight: 180,
    });
    expect(renderedTop(layout, 60, 180) + 90).toBe(190);
  });

  it('centers below a tall header in the band that is left', () => {
    const layout = getCenteredStateLayout({
      window: { top: 0, bottom: 800 },
      viewport: { top: 450, bottom: 800 },
      contentHeight: 200,
    });
    expect(renderedTop(layout, 450, 200) + 100).toBe(625);
  });

  it('keeps content above an overlay without counting its inset twice', () => {
    const layout = getCenteredStateLayout({
      window: { top: 0, bottom: 800 },
      viewport: { top: 100, bottom: 720 },
      bottomInset: 80,
      contentHeight: 600,
    });
    expect(renderedTop(layout, 100, 600) + 300).toBe(410);
  });

  it.each([
    {
      name: 'Android half-sheet',
      window: { top: 0, bottom: 640 },
      viewport: { top: 384, bottom: 640 },
      contentHeight: 177.5,
      center: 512,
    },
    {
      name: 'iOS language picker above the keyboard',
      window: { top: 0, bottom: 435 },
      viewport: { top: 155, bottom: 667 },
      contentHeight: 109,
      center: 295,
    },
    {
      name: 'Android language picker above the keyboard',
      window: { top: 0, bottom: 340 },
      viewport: { top: 173, bottom: 640 },
      contentHeight: 108.5,
      center: 256.5,
    },
  ])('centers inside the $name band', ({ window, viewport, contentHeight, center }) => {
    const layout = getCenteredStateLayout({ window, viewport, contentHeight });
    expect(renderedTop(layout, viewport.top, contentHeight) + contentHeight / 2).toBe(center);
    expect(renderedTop(layout, viewport.top, contentHeight) + contentHeight).toBeLessThanOrEqual(
      window.bottom
    );
  });

  it('does not force overflow when content exactly fills the available body', () => {
    const layout = getCenteredStateLayout({
      window: { top: 0, bottom: 400 },
      viewport: { top: 100, bottom: 400 },
      contentHeight: 300,
    });
    expect(renderedTop(layout, 100, 300)).toBe(100);
    expect(layout).toEqual({ minHeight: 300, paddingTop: 0, paddingBottom: 0 });
  });

  it('gives tall content normal scrollable padding rather than a negative offset', () => {
    const layout = getCenteredStateLayout({
      window: { top: 0, bottom: 400 },
      viewport: { top: 100, bottom: 400 },
      bottomInset: 40,
      contentHeight: 700,
    });
    expect(layout).toEqual({ minHeight: 300, paddingTop: 16, paddingBottom: 56 });
    expect(renderedTop(layout, 100, 700)).toBe(116);
  });

  it('does not add a second clearance for an overlay footer', () => {
    const layout = getCenteredStateLayout({
      window: { top: 0, bottom: 500 },
      viewport: { top: 80, bottom: 500 },
      bottomInset: 80,
      contentHeight: 700,
      nativeViewportFillsSurface: true,
    });
    expect(layout).toEqual({ minHeight: 420, paddingTop: 16, paddingBottom: 96 });
  });

  it('fills the sheet and centers inside its band when there is no footer', () => {
    const layout = getCenteredStateLayout({
      window: { top: 0, bottom: 800 },
      viewport: { top: 380, bottom: 800 },
      contentHeight: 120,
      nativeViewportFillsSurface: true,
    });
    expect(layout).toEqual({ minHeight: 420, paddingTop: 150, paddingBottom: 150 });
    expect(renderedTop(layout, 380, 120) + 60).toBe(590);
  });

  it('uses the visible viewport after keyboard avoidance', () => {
    const layout = getCenteredStateLayout({
      window: { top: 0, bottom: 500 },
      viewport: { top: 80, bottom: 440 },
      contentHeight: 120,
    });
    expect(renderedTop(layout, 80, 120) + 60).toBe(260);
  });

  it('keeps a clipped native sheet inside the window', () => {
    const layout = getCenteredStateLayout({
      window: { top: 0, bottom: 800 },
      viewport: { top: 480, bottom: 1100 },
      contentHeight: 120,
    });
    expect(renderedTop(layout, 480, 120) + 60).toBe(640);
    expect(layout.paddingBottom).toBe(400);
  });

  it.each([false, true])(
    'keeps a flow footer reachable with native fill %s',
    nativeViewportFillsSurface => {
      const viewport = { top: 80, bottom: 420 };
      const contentHeight = 700;
      const layout = getCenteredStateLayout({
        window: { top: 0, bottom: 500 },
        viewport,
        contentHeight,
        nativeViewportFillsSurface,
      });
      const nativeHeight = nativeViewportFillsSurface ? 420 : 340;
      const scrollRange = layout.paddingTop + contentHeight + layout.paddingBottom - nativeHeight;
      expect(layout.minHeight).toBe(nativeHeight);
      expect(layout.paddingBottom).toBe(nativeViewportFillsSurface ? 96 : 16);
      expect(renderedTop(layout, viewport.top, contentHeight) + contentHeight - scrollRange).toBe(
        404
      );
    }
  );

  it.each([0, 80])('preserves a short state above a flow footer with inset %s', bottomInset => {
    const layout = getCenteredStateLayout({
      window: { top: 0, bottom: 800 },
      viewport: { top: 380, bottom: 720 },
      bottomInset,
      contentHeight: 120,
      nativeViewportFillsSurface: true,
    });
    expect(layout).toEqual({ minHeight: 420, paddingTop: 110, paddingBottom: 190 });
    expect(renderedTop(layout, 380, 120) + 60).toBe(550);
  });
});

describe('native keyboard clipping', () => {
  const layoutWithKeyboard = (contentHeight: number) =>
    getCenteredStateLayout({
      window: { top: 0, bottom: 400 },
      viewport: { top: 80, bottom: 620 },
      contentHeight,
      nativeViewportFillsSurface: true,
      nativeViewportBottom: 700,
    });

  it('keeps the native scroll extent while centering above the keyboard', () => {
    const layout = layoutWithKeyboard(120);
    expect(layout).toEqual({ minHeight: 620, paddingTop: 100, paddingBottom: 400 });
    expect(renderedTop(layout, 80, 120) + 60).toBe(240);
  });

  it('keeps a long state action above the keyboard at the end of scrolling', () => {
    const layout = layoutWithKeyboard(800);
    const scrollRange = layout.paddingTop + 800 + layout.paddingBottom - layout.minHeight;
    expect(renderedTop(layout, 80, 800) + 800 - scrollRange).toBe(384);
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
        window: { top: 0, bottom: 540 },
        viewport: { top: 277, bottom: 540 },
        bottomInset: 117,
      })
    ).toEqual({ top: 277, bottom: 423, band: 146 });
  });

  it('clips the band to the visible viewport', () => {
    expect(
      getCenteredStateBand({
        window: { top: 0, bottom: 540 },
        viewport: { top: 277, bottom: 400 },
        bottomInset: 117,
      })
    ).toEqual({ top: 277, bottom: 400, band: 123 });
  });

  it('reserves the top inset as well', () => {
    expect(
      getCenteredStateBand({
        window: { top: 0, bottom: 800 },
        viewport: { top: 0, bottom: 800 },
        topInset: 60,
        bottomInset: 100,
      })
    ).toEqual({ top: 60, bottom: 700, band: 640 });
  });
});

describe('getPendingCenteredStateStyle', () => {
  it('paints a state exactly where the measured layout puts it', () => {
    // The measured history empty state: a full-height window, a scroller below
    // the page header, and the tab bar reserved at the bottom.
    const window = { top: 0, bottom: 914.29 };
    const viewport = { top: 155.81, bottom: 914.29 };
    const pending = getPendingCenteredStateStyle(78);
    for (const contentHeight of [120, 170.67, 320]) {
      const layout = getCenteredStateLayout({ window, viewport, bottomInset: 78, contentHeight });
      expect(
        renderedTop({ ...pending, minHeight: 758.48 }, viewport.top, contentHeight)
      ).toBeCloseTo(renderedTop(layout, viewport.top, contentHeight), 6);
    }
    const measured = getCenteredStateLayout({
      window,
      viewport,
      bottomInset: 78,
      contentHeight: 170.67,
    });
    expect(renderedTop(measured, viewport.top, 170.67)).toBeCloseTo(410.67, 1);
  });

  it.each([
    {
      name: 'a reserved top inset',
      window: { top: 0, bottom: 800 },
      viewport: { top: 173, bottom: 640 },
      topInset: 48,
      contentHeight: 108.5,
    },
    {
      name: 'a native filled viewport above the keyboard',
      window: { top: 0, bottom: 400 },
      viewport: { top: 80, bottom: 620 },
      nativeViewportFillsSurface: true,
      nativeViewportBottom: 700,
      contentHeight: 120,
    },
  ])('keeps the band style on the measured placement for $name', band => {
    const { contentHeight, ...geometry } = band;
    const bandStyle = getCenteredStateBandStyle(geometry);
    const layout = getCenteredStateLayout({ ...geometry, contentHeight });
    expect(renderedTop(bandStyle, geometry.viewport.top, contentHeight)).toBeCloseTo(
      renderedTop(layout, geometry.viewport.top, contentHeight),
      6
    );
  });

  it('matches the measured placement outside the strip its content nearly fills', () => {
    // The layout engine pins content inside the last `2 * STATE_GAP` of the band
    // where the measured layout still centers it. Everywhere else the two boxes
    // agree: both center a shorter state, and both pin one gap below the band's
    // top when it is taller than the band.
    const geometry = { window: { top: 0, bottom: 200 }, viewport: { top: 0, bottom: 200 } };
    const bandStyle = getCenteredStateBandStyle(geometry);
    const difference = (contentHeight: number) =>
      Math.abs(
        renderedTop(bandStyle, 0, contentHeight) -
          renderedTop(getCenteredStateLayout({ ...geometry, contentHeight }), 0, contentHeight)
      );
    expect(difference(100)).toBe(0);
    // `band - 2 * STATE_GAP`: the strip starts here, where both still agree.
    expect(difference(168)).toBe(0);
    expect(difference(260)).toBe(0);
    // Inside that strip the estimate is short by at most one gap, and the state
    // is scrollable there.
    expect(difference(184)).toBeLessThanOrEqual(16);
    expect(difference(190)).toBeLessThanOrEqual(16);
    // An exact fit is the worst case: one gap.
    expect(difference(200)).toBe(16);
  });

  it('keeps the bottom reserve free before the viewport is measured', () => {
    const pending = getPendingCenteredStateStyle(78);
    expect(pending.paddingBottom - pending.paddingTop).toBe(78);
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
