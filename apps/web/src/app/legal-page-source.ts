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

function absolutizeKiloLinks(html: string, sourceUrl: string): string {
  return html.replaceAll(/(href|src)="\/(?!\/)/g, `$1="${new URL('/', sourceUrl)}`);
}

// The marketing site opens its external links in a new tab; keep that behavior
// and follow the apps/web convention of pairing `target="_blank"` with
// `rel="noopener noreferrer"` even when the source document leaves `rel` out.
function enforceRelOnBlankTargets(_tagName: string, attribs: sanitizeHtml.Attributes) {
  if (attribs.target !== '_blank') {
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
    transformTags: { a: enforceRelOnBlankTargets },
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
