export type StateFrame = Readonly<{ top: number; bottom: number }>;

type CenteredStateLayoutInput = {
  surface: StateFrame;
  viewport: StateFrame;
  contentHeight: number;
  topInset?: number;
  bottomInset?: number;
  nativeViewportFillsSurface?: boolean;
  nativeViewportBottom?: number;
  roundToPixel?: (value: number) => number;
};

const STATE_GAP = 16;
const PREFERRED_CLEARANCE = 48;

export function getStateSurfaceInsets({
  surface,
  bounds,
  top,
  bottom,
}: {
  surface: StateFrame;
  bounds: StateFrame;
  top: number;
  bottom: number;
}) {
  return {
    topInset: Math.max(0, bounds.top + top - surface.top),
    bottomInset: Math.max(0, surface.bottom - (bounds.bottom - bottom)),
  };
}

export function intersectStateFrames(frame: StateFrame, clip: StateFrame): StateFrame {
  const top = Math.max(clip.top, Math.min(frame.top, clip.bottom));
  return { top, bottom: Math.max(top, Math.min(frame.bottom, clip.bottom)) };
}

/**
 * The bottom reserve a nested surface resolves. `replace` sets the given inset
 * as the surface's own reserve; otherwise the inset only raises the inherited
 * one, so a nested reservation can never shrink a surface's clearance. A screen
 * whose centered state must use the whole room above a hard overlay replaces:
 * the tab layout reserves the tab bar plus a content gap for scrolled content,
 * and a centered state that lost that gap could no longer show its hint and
 * action above the bar.
 */
export function resolveBottomReservation({
  inherited,
  bottomInset,
  replace,
}: {
  inherited: number;
  bottomInset: number;
  replace: boolean;
}) {
  return replace ? bottomInset : Math.max(inherited, bottomInset);
}

export function getCenteredStateLayout({
  surface,
  viewport,
  contentHeight,
  topInset = 0,
  bottomInset = 0,
  nativeViewportFillsSurface = false,
  nativeViewportBottom = surface.bottom,
  roundToPixel = (value: number) => value,
}: CenteredStateLayoutInput) {
  const viewportBottom = nativeViewportFillsSurface ? nativeViewportBottom : viewport.bottom;
  const visible = intersectStateFrames(viewport, surface);
  const top = Math.max(visible.top, surface.top + topInset);
  const bottom = Math.min(visible.bottom, surface.bottom - bottomInset);
  const idealTop = (surface.top + surface.bottom - contentHeight) / 2;
  const fits = contentHeight <= roundToPixel(bottom - top);
  const clearance = Math.min(PREFERRED_CLEARANCE, Math.max(0, (bottom - top - contentHeight) / 2));
  const contentTop = fits
    ? Math.max(top + clearance, Math.min(idealTop, bottom - contentHeight - clearance))
    : top + STATE_GAP;

  const paddingTop = Math.max(0, contentTop - viewport.top);
  const paddingBottom = fits
    ? Math.max(0, viewportBottom - contentTop - contentHeight)
    : Math.max(STATE_GAP, viewportBottom - bottom + STATE_GAP);
  const roundedPaddingTop = roundToPixel(paddingTop);

  return {
    minHeight: roundToPixel(Math.max(0, viewportBottom - viewport.top)),
    paddingTop: roundedPaddingTop,
    paddingBottom: roundToPixel(paddingTop + paddingBottom) - roundedPaddingTop,
  };
}
