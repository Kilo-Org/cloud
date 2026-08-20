const SAFE_IMAGE_DATA_URL = /^data:image\/(?:png|jpe?g|gif|webp|avif)[;,]/i;

export function toSafeHttpUrl(href: string | undefined): string | undefined {
  if (!href) return undefined;
  try {
    const url = new URL(href.trim());
    if (url.protocol === 'https:' || url.protocol === 'http:') {
      return href.trim();
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function toSafeImageSrc(src: string | undefined): string | undefined {
  if (!src) return undefined;
  const trimmed = src.trim();
  if (SAFE_IMAGE_DATA_URL.test(trimmed)) {
    return trimmed;
  }
  return toSafeHttpUrl(trimmed);
}
