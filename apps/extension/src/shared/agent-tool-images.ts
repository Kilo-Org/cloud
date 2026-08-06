/*
 * Newest tool images kept in memory, per panel load. A screenshot data URL is
 * often megabytes, and the side panel is long-lived, so this cannot grow
 * without a bound. Past the cap the oldest entry is evicted and that tool
 * panel falls back to rendering its text output — the image does not come
 * back, because the bytes were stripped before storage and are not refetched.
 * ponytail: fixed count cap; switch to a byte budget if large images start
 * evicting useful ones early.
 */
export const MAX_TOOL_IMAGES = 50;

const toolImages = new Map<string, string>();

export const rememberToolImage = (
  partId: string,
  attachment: { mime: string; filename?: string; dataUrl: string }
): void => {
  if (!attachment.mime.startsWith('image/')) {
    return;
  }
  if (attachment.dataUrl === '') {
    return;
  }
  toolImages.delete(partId);
  toolImages.set(partId, attachment.dataUrl);
  while (toolImages.size > MAX_TOOL_IMAGES) {
    const [oldest] = toolImages.keys();
    if (oldest === undefined) {
      break;
    }
    toolImages.delete(oldest);
  }
};

export const getToolImage = (partId: string): string | undefined => toolImages.get(partId);

/** Test-only reset. */
export const clearToolImages = (): void => {
  toolImages.clear();
};
