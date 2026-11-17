import sanitizeHtml from 'sanitize-html';

type ExtractLegalMainHtmlOptions = {
  html: string;
  sourceUrl: string;
  missingMessage: string;
};

// The markup contract with the fetched legal document: only these elements and
// attributes are rendered, and everything else the source page carries is dropped
// instead of being copied into the page.
const LEGAL_CONTENT_ALLOWED_TAGS = [
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'br',
  'hr',
  'ul',
  'ol',
  'li',
  'dl',
  'dt',
  'dd',
  'blockquote',
  'pre',
  'code',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'sub',
  'sup',
  'small',
  'span',
  'div',
  'a',
  'img',
  'table',
  'caption',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'td',
  'th',
  'figure',
  'figcaption',
  'mark',
  'abbr',
  'cite',
];

const LEGAL_CONTENT_ALLOWED_ATTRIBUTES = {
  a: ['href', 'target', 'rel', 'title'],
  img: ['src', 'alt', 'title', 'width', 'height'],
  ol: ['start'],
  td: ['colspan', 'rowspan'],
  th: ['colspan', 'rowspan', 'scope'],
  '*': ['id'],
};

const LEGAL_CONTENT_ALLOWED_SCHEMES = ['http', 'https', 'mailto', 'tel'];

// The store review surfaces render this content inside the app, so a link from a
// legal document to any other kilo.ai page (pricing, plans, the marketing site)
// is stripped down to its text: a legal document may not hand a reviewer a path
// to a purchase page. Links to the legal pages themselves stay, which keeps the
// terms -> privacy cross reference working.
const KILO_LEGAL_PATH = /^\/(?:terms|privacy)(?:\/|$)/;

// Every path the document links to resolves against the page it came from, so a
// relative href names the same kilo.ai destination as the live page and the
// marketing-link rule below sees it. An absolute URL, a scheme, a fragment and a
// protocol-relative target stay as written: the sanitizer's own scheme allowlist
// decides what survives them. An `&amp;` in a relative target is not an exemption
// either — the value reaches this transform still relative, and leaving it alone
// would keep a marketing link such as `/pricing?plan=pro` (or an image with a
// query string) pointing at app.kilo.ai.
const NOT_A_PATH = /^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i;

function absolutizeKiloLinks(html: string, sourceUrl: string): string {
  return html.replaceAll(/(href|src)="([^"]*)"/g, (match, attribute: string, target: string) =>
    NOT_A_PATH.test(target) ? match : `${attribute}="${new URL(target, sourceUrl).toString()}"`
  );
}

function isLegalDocumentLink(href: string): boolean {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    // A fragment-only or otherwise unparseable target names no destination to
    // strip; the sanitizer's own scheme allowlist decides what survives.
    return true;
  }

  if (url.hostname !== 'kilo.ai' && url.hostname !== 'www.kilo.ai') {
    return true;
  }

  return KILO_LEGAL_PATH.test(url.pathname);
}

// The marketing site opens its external links in a new tab; keep that behavior
// and follow the apps/web convention of pairing `target="_blank"` with
// `rel="noopener noreferrer"` even when the source document leaves `rel` out.
function transformLegalAnchor(_tagName: string, attribs: sanitizeHtml.Attributes) {
  if (attribs.href && !isLegalDocumentLink(attribs.href)) {
    // Downgrading to a span keeps the linked words and drops the destination,
    // so the copy still reads and nothing points at a marketing page.
    return { tagName: 'span', attribs: {} };
  }

  // HTML keyword attributes are ASCII case-insensitive.
  if (attribs.target?.trim().toLowerCase() !== '_blank') {
    return { tagName: 'a', attribs };
  }

  const rel = new Set(attribs.rel?.split(/\s+/).filter(Boolean));
  rel.add('noopener');
  rel.add('noreferrer');
  return { tagName: 'a', attribs: { ...attribs, rel: [...rel].join(' ') } };
}

function sanitizeLegalContent(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: LEGAL_CONTENT_ALLOWED_TAGS,
    allowedAttributes: LEGAL_CONTENT_ALLOWED_ATTRIBUTES,
    allowedSchemes: LEGAL_CONTENT_ALLOWED_SCHEMES,
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
    transformTags: { a: transformLegalAnchor },
  });
}

export function extractLegalMainHtml(options: ExtractLegalMainHtmlOptions): string {
  const match = options.html.match(/<main\b[^>]*>([\s\S]*)<\/main>/i);
  if (!match?.[1]) {
    throw new Error(options.missingMessage);
  }

  const content = sanitizeLegalContent(absolutizeKiloLinks(match[1], options.sourceUrl)).trim();
  if (!content) {
    throw new Error(options.missingMessage);
  }

  return content;
}

/** Revalidate the fetched legal source once an hour, as the rendered pages do. */
export const LEGAL_SOURCE_REVALIDATE_SECONDS = 3600;

/**
 * Load one legal document's sanitized body. Throws when the source is
 * unreachable or the document has no main content, which lets the app route
 * distinguish a retryable fetch failure from a successful response with a
 * fallback notice; the pages wrap this in their own fallback.
 */
export async function loadLegalMainHtml(options: {
  sourceUrl: string;
  extract: (html: string) => string;
}): Promise<string> {
  const response = await fetch(options.sourceUrl, {
    next: { revalidate: LEGAL_SOURCE_REVALIDATE_SECONDS },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${options.sourceUrl}: ${response.status}`);
  }

  return options.extract(await response.text());
}
