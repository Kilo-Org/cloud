import { type TFunction } from 'i18next';
import { marked, type Token, type Tokens, type TokensList } from 'marked';

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
  return value.includes('![') ? collectImages(lexMarkdown(value)) : [];
}

function collectImages(tokens: TokensList): MarkdownImageRef[] {
  const linked = new Set<Token>();
  const images: MarkdownImageRef[] = [];
  // `walkTokens` returns the async-extension promises; none are registered.
  void marked.walkTokens(tokens, token => {
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

/**
 * Whole-value lexes one gate pass may spend telling images from literal copies.
 * Past it every copy is rewritten, so crafted repetition cannot stall a render.
 */
const MAX_IMAGE_PROBES = 8;

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
 * data images an "HTTPS images only" note. A copy of the image syntax that
 * `marked` reads as literal text (code, an escaped `\!`) is left alone while the
 * probe budget lasts. If a copy cannot be located, every copy is rewritten and
 * its URL is replaced so it still never loads.
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
  const edits: { start: number; end: number; text: string }[] = [];
  const unfoundHrefs: string[] = [];
  let probesLeft = MAX_IMAGE_PROBES;
  for (const [raw, { image, count }] of byRaw) {
    const all = occurrences(value, raw);
    // With no more copies than images every copy is an image. Otherwise, while
    // the budget lasts, tell images from literal text with the lexer: swapping
    // a copy's `!` for a letter turns a real image into a link and changes
    // nothing else, so the image count drops only for a real copy. The probe
    // lexes uncached so it never evicts real values from the parse cache.
    // Without budget every copy is rewritten, which is safe.
    const probe = all.length > count && all.length <= probesLeft;
    if (probe) {
      probesLeft -= all.length;
    }
    const images = probe
      ? all.filter(at => {
          const probed = `${value.slice(0, at)}x${value.slice(at + 1)}`;
          const left = collectImages(marked.lexer(probed, { gfm: true }));
          return left.filter(other => other.raw === raw).length < count;
        })
      : all;
    const located = images.length >= count;
    if (!located) {
      unfoundHrefs.push(image.href);
    }
    const text = gatedImageMarkdown(image, t);
    for (const at of located ? images : all) {
      edits.push({ start: at, end: at + raw.length, text });
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
