import { type FilePart, type ToolPart } from '@kilocode/cloud-agent-sdk';

export const IMAGE_PREVIEW_MAX_ASPECT_RATIO = 3;
export const IMAGE_PREVIEW_MIN_ASPECT_RATIO = 0.75;
export const IMAGE_PREVIEW_FALLBACK_ASPECT_RATIO = 4 / 3;

/**
 * Image attachments on a completed tool part.
 *
 * Blank-`url` entries are kept: store URLs are always blank by design after the
 * chat-processor strip, and the file-system cache (via `useToolCardImageUri`)
 * decides renderability. The renderer shows a terminal message when no cached
 * bytes exist instead of a broken image. Non-image mimes (application/pdf) are
 * dropped — they keep today's invisible behaviour.
 */
export function getToolImageAttachments(part: ToolPart): FilePart[] {
  if (part.state.status !== 'completed') {
    return [];
  }
  return (part.state.attachments ?? []).filter(item => item.mime.startsWith('image/'));
}

/**
 * Clamp an image's intrinsic ratio so a tall screenshot still gets a usable
 * preview height in a tool card. `contentFit="contain"` letterboxes the rest.
 */
export function resolveImagePreviewAspectRatio(width: number, height: number): number {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return IMAGE_PREVIEW_FALLBACK_ASPECT_RATIO;
  }
  const ratio = width / height;
  if (ratio < IMAGE_PREVIEW_MIN_ASPECT_RATIO) {
    return IMAGE_PREVIEW_MIN_ASPECT_RATIO;
  }
  if (ratio > IMAGE_PREVIEW_MAX_ASPECT_RATIO) {
    return IMAGE_PREVIEW_MAX_ASPECT_RATIO;
  }
  return ratio;
}
