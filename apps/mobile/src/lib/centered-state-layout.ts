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

/**
 * The tallest window that is still a phone held sideways. A phone's short edge
 * tops out around 480dp and a tablet's is at least 768dp, so this sits in the
 * empty gap between them: above it the band between the page header and the tab
 * bar is taller than any centered state's full stack and nothing needs to give.
 */
const SHORT_WINDOW_MAX_HEIGHT = 600;

/**
 * Whether the window is a short one — a phone held sideways.
 *
 * A centered state is centered in the band the surface leaves between the page
 * header and the fixed bottom tab bar, and that band is only tall while the
 * window is taller than it is wide. On a 411dp-tall landscape window the band
 * is ~120dp — and ~49dp once the FAB's own 72dp strip is reserved as well —
 * against the ~167dp the Agents no-match state's icon bubble, its copy and its
 * action need stacked, so `getCenteredStateLayout` cannot fit it: the body is
 * pinned to the top of the band and the copy and the action spill under the
 * tab bar, which owns the taps there, and only a scroll brings them back.
 * Callers that can drop decoration for a short window ask this.
 *
 * Both halves matter: a portrait window is tall even when the keyboard shortens
 * it, and a tablet in landscape is wide but tall enough to keep the full stack.
 * An unavailable dimension (a partial platform mock) is never a short window.
 *
 * `CenteredState` owns the band, so it is the one that asks this and publishes
 * the answer as the short-centered-band flag; a state that can drop decoration
 * for a short band reads that (`useShortCenteredBand`). Nothing outside a
 * centered scroller is short.
 */
export function isShortViewport(width: number, height: number): boolean {
  return (
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width > height &&
    height <= SHORT_WINDOW_MAX_HEIGHT
  );
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
