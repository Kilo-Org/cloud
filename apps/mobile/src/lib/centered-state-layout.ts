export type StateFrame = Readonly<{ top: number; bottom: number }>;

type CenteredStateLayoutInput = {
  surface: StateFrame;
  viewport: StateFrame;
  contentHeight: number;
  topInset?: number;
  bottomInset?: number;
  nativeViewportFillsSurface?: boolean;
  nativeViewportBottom?: number;
};

const STATE_GAP = 16;

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

export function getCenteredStateLayout({
  surface,
  viewport,
  contentHeight,
  topInset = 0,
  bottomInset = 0,
  nativeViewportFillsSurface = false,
  nativeViewportBottom = surface.bottom,
}: CenteredStateLayoutInput) {
  const viewportBottom = nativeViewportFillsSurface ? nativeViewportBottom : viewport.bottom;
  const visible = intersectStateFrames(viewport, surface);
  const top = Math.max(visible.top, surface.top + topInset);
  const bottom = Math.min(visible.bottom, surface.bottom - bottomInset);
  const idealTop = (surface.top + surface.bottom - contentHeight) / 2;
  const centered = idealTop >= top && idealTop + contentHeight <= bottom;
  const contentTop = centered
    ? idealTop
    : Math.max(top + STATE_GAP, Math.min(idealTop, bottom - STATE_GAP - contentHeight));

  return {
    minHeight: Math.max(0, viewportBottom - viewport.top),
    paddingTop: Math.max(0, contentTop - viewport.top),
    paddingBottom: centered
      ? Math.max(0, viewportBottom - contentTop - contentHeight)
      : Math.max(STATE_GAP, viewportBottom - bottom + STATE_GAP),
  };
}
