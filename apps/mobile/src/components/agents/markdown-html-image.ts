import { resolveImagePreviewAspectRatio } from './tool-card-attachments';

export type HtmlImage = {
  src: string;
  alt: string;
  /** width/height attributes when both are present and positive; else undefined. */
  aspectRatio: number | undefined;
};

const ENTITIES = {
  '&amp;': '&',
  '&quot;': '"',
  '&#39;': "'",
  '&lt;': '<',
  '&gt;': '>',
} satisfies Record<string, string>;

const ENTITY_RE = /&(?:amp|quot|#39|lt|gt);/g;

function decodeEntities(value: string): string {
  return value.replace(ENTITY_RE, match =>
    Object.hasOwn(ENTITIES, match) ? ENTITIES[match as keyof typeof ENTITIES] : match
  );
}

const ATTR_SRC = /(?:^|\s)src\s*=\s*["']([^"']*)["']/i;
const ATTR_ALT = /(?:^|\s)alt\s*=\s*["']([^"']*)["']/i;
const ATTR_WIDTH = /(?:^|\s)width\s*=\s*["']([^"']*)["']/i;
const ATTR_HEIGHT = /(?:^|\s)height\s*=\s*["']([^"']*)["']/i;

const IMG_TAG_RE = /<img\b[^>]*\/?>/gi;

function attrValue(tag: string, re: RegExp): string | undefined {
  return tag.match(re)?.[1];
}

/** A token renders as images only when it carries nothing but tags and whitespace. Caller strips comments first. */
const TAGS_AND_WHITESPACE_RE = /^(\s|<[^>]*>)*$/;

function isImagesOnly(cleaned: string): boolean {
  return TAGS_AND_WHITESPACE_RE.test(cleaned);
}

export function isSupportedScheme(src: string): boolean {
  return src.startsWith('http://') || src.startsWith('https://') || src.startsWith('data:image/');
}

/**
 * Remove every match of `re`, iterating to a fixed point. A single global pass can
 * join the survivors of one match into a new match across the removal boundary:
 * `<<!-- -->!-- -->` single-passes to the residual comment `<!-- -->`, which the
 * loop then clears. Each pass either removes at least one character or makes no
 * change, so the loop terminates.
 */
export function stripToFixedPoint(value: string, re: RegExp): string {
  let current = value;
  for (;;) {
    const next = current.replaceAll(re, '');
    if (next === current) {
      return current;
    }
    current = next;
  }
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
  const stripped = stripToFixedPoint(html, /<!--[\s\S]*?-->/g);

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
