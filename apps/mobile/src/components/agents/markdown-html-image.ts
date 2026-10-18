import { resolveImagePreviewAspectRatio } from './tool-card-attachments';

export function isSupportedScheme(src: string): boolean {
  return src.startsWith('http://') || src.startsWith('https://') || src.startsWith('data:image/');
}

/**
 * width/height attributes → clamped preview aspect ratio, but only when both
 * parse as positive finite numbers; otherwise `undefined` so the renderer can
 * adopt the intrinsic ratio measured on load.
 */
export function resolveHtmlImageAspectRatio(
  width: string | undefined,
  height: string | undefined
): number | undefined {
  if (width === undefined || height === undefined) {
    return undefined;
  }
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return undefined;
  }
  return resolveImagePreviewAspectRatio(w, h);
}
