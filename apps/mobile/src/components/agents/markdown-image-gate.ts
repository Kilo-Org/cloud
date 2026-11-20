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
  if (!url.startsWith(IMAGE_LOAD_SCHEME)) {
    return null;
  }
  try {
    return decodeURIComponent(url.slice(IMAGE_LOAD_SCHEME.length));
  } catch {
    return null;
  }
}

function escapeMarkdownText(text: string): string {
  return text.replaceAll(/\s+/g, ' ').replaceAll(/[\\`*_[\]<>!#~|()&]/g, String.raw`\$&`);
}

/**
 * Percent-encoded link destination for an image URL, or null when the URL holds
 * a lone surrogate and cannot be encoded. `image.href` comes from rendered
 * markdown, so encoding it must not raise.
 */
function imageLoadDestination(href: string): string | null {
  try {
    return encodeURIComponent(href).replaceAll('(', '%28').replaceAll(')', '%29');
  } catch {
    return null;
  }
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
  const destination = imageLoadDestination(image.href);
  if (destination === null) {
    // A URL that cannot be percent-encoded has no load link to offer.
    return escapeMarkdownText(prefix + (host ?? t('agentChat.markdownImage.httpsOnly')));
  }
  return `[${escapeMarkdownText(prefix + load)}](${IMAGE_LOAD_SCHEME}${destination})`;
}

/**
 * Whole-value lexes one gate pass may spend telling images from literal copies.
 * Past it every copy is rewritten, and every other pass over the value is a
 * single traversal, so crafted repetition cannot stall a render.
 */
const MAX_IMAGE_PROBES = 8;

/** One character per edge; `raw` marks the end of the key spelled by the path. */
type TrieNode = { children: Map<string, TrieNode>; raw: string | null };

function buildTrie(keys: readonly string[]): TrieNode {
  const root: TrieNode = { children: new Map(), raw: null };
  for (const key of keys) {
    let node = root;
    // Code units, not code points: the walk over the value reads single units.
    for (let index = 0; index < key.length; index += 1) {
      const char = key.charAt(index);
      let child = node.children.get(char);
      if (child === undefined) {
        child = { children: new Map(), raw: null };
        node.children.set(char, child);
      }
      node = child;
    }
    node.raw = key;
  }
  return root;
}

/**
 * Every occurrence of every key in `value`, overlapping ones included, from one
 * left-to-right traversal: a bucket per key, ascending, with a restart per key
 * avoided. A key that ends inside a longer key's path still gets its own hits.
 */
function locateOccurrences(value: string, keys: readonly string[]): Map<string, number[]> {
  const buckets = new Map<string, number[]>();
  for (const key of keys) {
    buckets.set(key, []);
  }
  const root = buildTrie(keys);
  for (let start = 0; start < value.length; start += 1) {
    let node = root.children.get(value.charAt(start));
    let end = start;
    while (node !== undefined) {
      const key = node.raw;
      if (key !== null) {
        buckets.get(key)?.push(start);
      }
      end += 1;
      node = node.children.get(value.charAt(end));
    }
  }
  return buckets;
}

/**
 * `indexOf` restarts at the end of the copy it just kept, so a candidate that
 * overlaps it is skipped: keep only the hits at or past the previous copy's end.
 */
function occurrences(candidates: readonly number[], length: number): number[] {
  const found: number[] = [];
  let cursor = 0;
  for (const at of candidates) {
    if (at >= cursor) {
      found.push(at);
      cursor = at + length;
    }
  }
  return found;
}

/**
 * Whether a match of `href` can only exist across an emitted load scheme: its
 * last characters are the scheme's first ones, or its first characters are the
 * scheme's last ones, so the copy spans the seam the replacement makes.
 */
function crossesImageLoadScheme(href: string): boolean {
  for (let length = 1; length < href.length && length <= IMAGE_LOAD_SCHEME.length; length += 1) {
    if (IMAGE_LOAD_SCHEME.startsWith(href.slice(href.length - length))) {
      return true;
    }
    if (IMAGE_LOAD_SCHEME.endsWith(href.slice(0, length))) {
      return true;
    }
  }
  return false;
}

/**
 * Whether the hrefs can share one left-to-right pass. Replacing them one at a
 * time differs whenever a pass changes what a later href still sees: one href
 * occurring inside another (or inside the load scheme), a copy that only exists
 * across an emitted scheme, or two hrefs matching the same characters. Those
 * keep the sequential loop; everything else is independent of the order.
 */
function hrefsRewriteIndependently(hrefs: readonly string[]): boolean {
  if (hrefs.some(href => IMAGE_LOAD_SCHEME.includes(href) || crossesImageLoadScheme(href))) {
    return false;
  }
  // One href inside another is a trie walk, not a rescan per pair: the trie
  // holds every href, so walking an href from each of its starts meets a
  // terminal only where another href begins inside it.
  const root = buildTrie(hrefs);
  return !hrefs.some(href => holdsAnotherHref(href, root));
}

/** Whether `href` spells a different href starting at any of its characters. */
function holdsAnotherHref(href: string, root: TrieNode): boolean {
  for (let start = 0; start < href.length; start += 1) {
    let node = root.children.get(href.charAt(start));
    let end = start;
    while (node !== undefined) {
      // At the walk's first character only a shorter prefix href closes here;
      // from any later character, every terminal is another href inside this one.
      if (node.raw !== null && (node.raw !== href || start > 0)) {
        return true;
      }
      end += 1;
      node = node.children.get(href.charAt(end));
    }
  }
  return false;
}

/** The href spelled at `at`, or null; independent hrefs allow no other choice. */
function hrefAt(value: string, at: number, root: TrieNode): string | null {
  let node = root.children.get(value.charAt(at));
  let end = at;
  while (node?.raw === null) {
    end += 1;
    node = node.children.get(value.charAt(end));
  }
  return node === undefined ? null : node.raw;
}

/**
 * One pass that stands in for a `replaceAll` per href: where an href starts,
 * emit the load scheme in its place. Null when a copy of another href overlaps
 * one already taken, which only the order of the sequential loop can settle.
 */
function substituteImageLoadLinks(value: string, hrefs: readonly string[]): string | null {
  const root = buildTrie(hrefs);
  const parts: string[] = [];
  let copied = 0;
  let at = 0;
  let covered = 0;
  let covering: string | null = null;
  while (at < value.length) {
    const match = hrefAt(value, at, root);
    // `replaceAll` skips a copy overlapping the one it already replaced, but a
    // copy of another href leaves the outcome to the order of the sequential
    // loop.
    if (match !== null && at < covered && match !== covering) {
      return null;
    }
    if (match !== null && at >= covered) {
      parts.push(value.slice(copied, at), IMAGE_LOAD_SCHEME);
      covered = at + match.length;
      copied = covered;
      covering = match;
    }
    // One character at a time: another href may start inside the copy just taken.
    at += 1;
  }
  parts.push(value.slice(copied));
  return parts.join('');
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
  const buckets = locateOccurrences(value, [...byRaw.keys()]);
  let probesLeft = MAX_IMAGE_PROBES;
  for (const [raw, { image, count }] of byRaw) {
    const all = occurrences(buckets.get(raw) ?? [], raw.length);
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
  // One href can go unfound many times; its first appearance decides its place.
  const hrefs = [...new Set(unfoundHrefs)];
  if (hrefs.length === 0) {
    return rewritten;
  }
  if (hrefsRewriteIndependently(hrefs)) {
    const onePass = substituteImageLoadLinks(rewritten, hrefs);
    if (onePass !== null) {
      return onePass;
    }
  }
  for (const href of hrefs) {
    rewritten = rewritten.replaceAll(href, IMAGE_LOAD_SCHEME);
  }
  return rewritten;
}
