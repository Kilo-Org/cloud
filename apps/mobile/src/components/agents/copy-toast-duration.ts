/**
 * How long a clipboard-copy confirmation toast stays up.
 *
 * Android's system clipboard preview (Android 13+) covers the bottom-center
 * toast region for roughly six seconds after a copy, so a default-length
 * success toast is hidden for its entire life on those devices. Keep the
 * confirmation up long enough to be seen once the preview clears.
 *
 * Every copy path that confirms through the bottom-center toast shares this
 * value: the message-details copy and the session header's Copy-link action
 * land in the same region, so a second path with the Sonner default would be
 * invisible on exactly the devices the first one was fixed for.
 *
 * Deliberately a leaf module with no imports: the copy paths that use it are
 * unit-tested in the pure project, which cannot load expo native modules.
 */
export const COPY_TOAST_DURATION_MS = 8000;
