import { resolveImagePreviewAspectRatio } from './tool-card-attachments';

export type HtmlImage = {
  src: string;
  alt: string;
  /** width/height attributes when both are present and positive; else undefined. */
  aspectRatio: number | undefined;
};

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&quot;': '"',
  '&#39;': "'",
  '&lt;': '<',
  '&gt;': '>',
};

const ENTITY_RE = /&(?:amp|quot|#39|lt|gt);/g;

function decodeEntities(value: string): string {
  return value.replace(ENTITY_RE, match => ENTITIES[match] ?? match);
}

const ATTR_SRC = /src\s*=\s*["']([^"']*)["']/i;
const ATTR_ALT = /alt\s*=\s*["']([^"']*)["']/i;
const ATTR_WIDTH = /width\s*=\s*["']([^"']*)["']/i;
const ATTR_HEIGHT = /height\s*=\s*["']([^"']*)["']/i;

const IMG_TAG_RE = /<img\b[^>]*\/?>/gi;

function attrValue(tag: string, re: RegExp): string | undefined {
  return tag.match(re)?.[1];
}

/** Strip HTML comments then check whether a token carries nothing but tags and whitespace. */
function isImagesOnly(cleaned: string): boolean {
  return cleaned.replaceAll(/<[^>]*>/g, '').replaceAll(/\s/g, '').length === 0;
}

export function isSupportedScheme(src: string): boolean {
  return src.startsWith('http://') || src.startsWith('https://') || src.startsWith('data:image/');
}

function imgTagToImage(tag: string): HtmlImage | null {
  const srcRaw = attrValue(tag, ATTR_SRC);
  if (srcRaw === undefined) {
    return null;
  }
  const src = decodeEntities(srcRaw);
  if (!isSupportedScheme(src)) {
    return null;
  }

  const altRaw = attrValue(tag, ATTR_ALT);
  const alt = altRaw !== undefined ? decodeEntities(altRaw) : '';

  let aspectRatio: number | undefined = undefined;
  const widthRaw = attrValue(tag, ATTR_WIDTH);
  const heightRaw = attrValue(tag, ATTR_HEIGHT);
  if (widthRaw !== undefined && heightRaw !== undefined) {
    const w = Number(widthRaw);
    const h = Number(heightRaw);
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
      aspectRatio = resolveImagePreviewAspectRatio(w, h);
    }
  }

  return { src, alt, aspectRatio };
}

/**
 * Parse images-only HTML tokens.
 *
 * Returns `[]` for mixed (text + image) tokens and for tokens with no usable
 * `<img>`, so callers fall back to literal-text rendering without losing text.
 * HTML comments are stripped before matching — a commented-out `<img>` must
 * stay invisible.
 */
export function parseHtmlImages(html: string): HtmlImage[] {
  // 1. Strip HTML comments.
  const stripped = html.replaceAll(/<!--[\s\S]*?-->/g, '');

  // 2. Match every <img …> tag.
  const tags = stripped.match(IMG_TAG_RE);
  if (!tags || tags.length === 0) {
    return [];
  }

  // 3. If there's text beyond tags and whitespace, drop everything — never
  //    silently lose text mixed with images.
  if (!isImagesOnly(stripped)) {
    return [];
  }

  const images: HtmlImage[] = [];
  for (const tag of tags) {
    const parsed = imgTagToImage(tag);
    if (parsed !== null) {
      images.push(parsed);
    }
  }
  return images;
}
