type ExtractLegalMainHtmlOptions = {
  html: string;
  sourceUrl: string;
  missingMessage: string;
};

function absolutizeKiloLinks(html: string, sourceUrl: string): string {
  return html.replaceAll(/(href|src)="\/(?!\/)/g, `$1="${new URL('/', sourceUrl)}`);
}

function removeActiveContent(html: string): string {
  let previous: string;
  let sanitized = html;

  do {
    previous = sanitized;
    sanitized = sanitized
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, '')
      .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  } while (sanitized !== previous);

  return sanitized;
}

function removeSourceAttributes(html: string): string {
  return removeActiveContent(html)
    .replaceAll(/\sclass="[^"]*"/g, '')
    .replaceAll(/\sdata-sentry-[a-z-]+="[^"]*"/g, '')
    .replaceAll(/\sstyle="[^"]*"/g, '');
}

export function extractLegalMainHtml(options: ExtractLegalMainHtmlOptions): string {
  const match = options.html.match(/<main\b[^>]*>([\s\S]*)<\/main>/i);
  if (!match?.[1]) {
    throw new Error(options.missingMessage);
  }

  return removeSourceAttributes(absolutizeKiloLinks(match[1], options.sourceUrl)).trim();
}
