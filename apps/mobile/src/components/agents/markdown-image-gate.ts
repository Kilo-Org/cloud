import { type TFunction } from 'i18next';
import { marked, type Token, type Tokens } from 'marked';

import { formatTrustedImageHost } from '@/lib/hooks/use-trusted-image-hosts';

import { isMarkdownImageLoadAllowed } from './markdown-image-confirm';
import { lexMarkdown } from './markdown-parse-cache';

/**
 * Destination of the "Load" link that stands in for a gated image. The native
 * markdown view never fetches it; `MarkdownEnriched` turns a press on it into
 * the image-trust dialog.
 */
const IMAGE_LOAD_SCHEME = 'kilo-image-load:';

export type MarkdownImageRef = {
  href: string;
  alt: string;
  /** The image syntax exactly as the source spells it. */
  raw: string;
  /** Inside a link: a nested "Load" link would break the outer one. */
  inLink: boolean;
};

/**
 * Every image in `value` (GFM, as `marked` lexes it), in document order,
 * including images in lists, quotes, links, and table cells. A value with no
 * `![` cannot hold an image, so streaming text skips the lex.
 */
export function findMarkdownImages(value: string): MarkdownImageRef[] {
  if (!value.includes('![')) {
    return [];
  }
  const linked = new Set<Token>();
  const images: MarkdownImageRef[] = [];
  // `walkTokens` returns the async-extension promises; none are registered.
  void marked.walkTokens(lexMarkdown(value), token => {
    if (token.type === 'link') {
      void marked.walkTokens((token as Tokens.Link).tokens, child => {
        linked.add(child);
      });
    }
    if (token.type === 'image') {
      const image = token as Tokens.Image;
      images.push({ href: image.href, alt: image.text, raw: image.raw, inLink: linked.has(token) });
    }
  });
  return images;
}

/**
 * Whether the native view may fetch the image: HTTPS only, and only once the
 * reader confirmed this URI or trusts its host (`markdown-image-confirm`).
 */
export function isMarkdownImageDisplayable(href: string): boolean {
  return href.startsWith('https://') && isMarkdownImageLoadAllowed(href);
}

/** The image URI behind a gated image's "Load" link, or null for any other link. */
export function parseImageLoadUrl(url: string): string | null {
  return url.startsWith(IMAGE_LOAD_SCHEME)
    ? decodeURIComponent(url.slice(IMAGE_LOAD_SCHEME.length))
    : null;
}

function escapeMarkdownText(text: string): string {
  return text.replaceAll(/\s+/g, ' ').replaceAll(/[\\`*_[\]<>!#~|()&]/g, String.raw`\$&`);
}

function gatedImageMarkdown(image: MarkdownImageRef, t: TFunction): string {
  const host = formatTrustedImageHost(image.href);
  const prefix = image.alt.trim() ? `${image.alt.trim()} · ` : '';
  if (!image.href.startsWith('https://')) {
    // http and data URIs never load, matching the HTML image chip.
    const label = host
      ? `${host} · ${t('agentChat.markdownImage.httpsOnly')}`
      : t('agentChat.markdownImage.httpsOnly');
    return escapeMarkdownText(prefix + label);
  }
  const load = host
    ? t('agentChat.markdownImage.loadWithHost', { host })
    : t('agentChat.markdownImage.load');
  if (image.inLink) {
    // The outer link keeps working; a nested link would split it.
    return escapeMarkdownText(prefix + (host ?? t('agentChat.markdownImage.httpsOnly')));
  }
  const destination = encodeURIComponent(image.href).replaceAll('(', '%28').replaceAll(')', '%29');
  return `[${escapeMarkdownText(prefix + load)}](${IMAGE_LOAD_SCHEME}${destination})`;
}

const FENCE_OPEN = /^(?:[ \t]*>)*[ \t]*(`{3,}|~{3,})/;

/**
 * Source ranges of fenced code blocks and inline code spans, where image
 * syntax is literal text and must not be rewritten. An unclosed fence runs to
 * the end, as it does while streaming.
 */
function codeRanges(value: string): [number, number][] {
  const ranges: [number, number][] = [];
  let fence: { marker: string; start: number } | null = null;
  let offset = 0;
  let textStart = 0;
  for (const line of value.split('\n')) {
    const lineEnd = offset + line.length;
    const marker = FENCE_OPEN.exec(line)?.[1];
    if (fence === null && marker !== undefined) {
      ranges.push(...codeSpanRanges(value, textStart, offset));
      fence = { marker, start: offset };
    } else if (
      fence !== null &&
      marker?.startsWith(fence.marker) &&
      line.trimEnd().endsWith(marker)
    ) {
      ranges.push([fence.start, lineEnd]);
      fence = null;
      textStart = lineEnd;
    }
    offset = lineEnd + 1;
  }
  if (fence === null) {
    ranges.push(...codeSpanRanges(value, textStart, value.length));
  } else {
    ranges.push([fence.start, value.length]);
  }
  return ranges;
}

/** Inline code spans in `value[start, end)`: a backtick run closed by the next run of the same length. */
function codeSpanRanges(value: string, start: number, end: number): [number, number][] {
  const ranges: [number, number][] = [];
  const runs = [...value.slice(start, end).matchAll(/`+/g)];
  for (let open = 0; open < runs.length; open += 1) {
    const opening = runs[open];
    const closeAt = opening
      ? runs.findIndex((run, index) => index > open && run[0].length === opening[0].length)
      : -1;
    const closing = runs[closeAt];
    if (opening && closing) {
      ranges.push([start + opening.index, start + closing.index + closing[0].length]);
      open = closeAt;
    }
  }
  return ranges;
}

function occurrences(value: string, raw: string): number[] {
  const found: number[] = [];
  for (let at = value.indexOf(raw); at !== -1; at = value.indexOf(raw, at + raw.length)) {
    found.push(at);
  }
  return found;
}

/**
 * Rewrites every image in `blocked` so the native markdown view never fetches
 * it: HTTPS images become a "Load" link (see `parseImageLoadUrl`), http and
 * data images an "HTTPS images only" note. Image syntax inside code is left
 * alone. If an image's syntax cannot be told apart from code, every copy is
 * rewritten; if it cannot be found at all, its URL is replaced so it still
 * never loads.
 */
export function gateMarkdownImages(
  value: string,
  blocked: readonly MarkdownImageRef[],
  t: TFunction
): string {
  if (blocked.length === 0) {
    return value;
  }
  const byRaw = new Map<string, { image: MarkdownImageRef; count: number }>();
  for (const image of blocked) {
    const entry = byRaw.get(image.raw);
    // A linked copy wins: plain text is safe both inside and outside a link.
    byRaw.set(image.raw, {
      image: entry && !image.inLink ? entry.image : image,
      count: (entry?.count ?? 0) + 1,
    });
  }
  const code = codeRanges(value);
  const edits: { start: number; end: number; text: string }[] = [];
  const unfoundHrefs: string[] = [];
  for (const [raw, { image, count }] of byRaw) {
    const all = occurrences(value, raw);
    if (all.length === 0) {
      unfoundHrefs.push(image.href);
    } else {
      const outside = all.filter(
        at => !code.some(([start, end]) => at < end && at + raw.length > start)
      );
      const text = gatedImageMarkdown(image, t);
      for (const at of outside.length >= count ? outside : all) {
        edits.push({ start: at, end: at + raw.length, text });
      }
    }
  }
  edits.sort((a, b) => a.start - b.start);
  let rewritten = '';
  let cursor = 0;
  for (const edit of edits) {
    // An overlapping edit sits inside an earlier image's escaped alt text.
    if (edit.start >= cursor) {
      rewritten += value.slice(cursor, edit.start) + edit.text;
      cursor = edit.end;
    }
  }
  rewritten += value.slice(cursor);
  for (const href of unfoundHrefs) {
    rewritten = rewritten.replaceAll(href, IMAGE_LOAD_SCHEME);
  }
  return rewritten;
}
