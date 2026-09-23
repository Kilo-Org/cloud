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
 * The band a centered state may occupy: the measured viewport clipped to the
 * surface and to the reserved top/bottom insets. `getCenteredStateLayout`
 * centers inside it; a state that cannot fit it renders its compact form, so
 * the two must read the same numbers.
 */
export function getCenteredStateBand({
  surface,
  viewport,
  topInset = 0,
  bottomInset = 0,
}: {
  surface: StateFrame;
  viewport: StateFrame;
  topInset?: number;
  bottomInset?: number;
}) {
  const visible = intersectStateFrames(viewport, surface);
  const top = Math.max(visible.top, surface.top + topInset);
  const bottom = Math.min(visible.bottom, surface.bottom - bottomInset);
  return { top, bottom, band: Math.max(0, bottom - top) };
}

/**
 * The bottom reserve a nested surface resolves: the larger of the inherited
 * reserve and the inset the nested surface asks for, so a nested reservation
 * can never shrink a surface's clearance. The tabs layout reserves the tab bar
 * alone (its 16dp content gap is content-only), so the Agents screen's centered
 * states resolve exactly the bar plus the FAB band they ask for.
 */
export function getBottomReservation({
  inherited,
  bottomInset,
}: {
  inherited: number;
  bottomInset: number;
}) {
  return Math.max(inherited, bottomInset);
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
  const { top, bottom } = getCenteredStateBand({
    surface,
    viewport,
    topInset,
    bottomInset,
  });
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
