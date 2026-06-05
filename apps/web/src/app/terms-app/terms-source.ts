export const TERMS_SOURCE_URL = 'https://kilo.ai/terms';

const TERMS_CONTACT_EMAIL = ['support', 'kilo.ai'].join('@');

export const TERMS_FALLBACK_HTML = `
<h1>Terms of Use</h1>
<p>The full Kilo terms are temporarily unavailable. Please try again shortly.</p>
<p>For terms questions, contact <a href="mailto:${TERMS_CONTACT_EMAIL}">${TERMS_CONTACT_EMAIL}</a>.</p>
`.trim();

function absolutizeKiloLinks(html: string): string {
  return html.replaceAll(/(href|src)="\/(?!\/)/g, `$1="${new URL('/', TERMS_SOURCE_URL)}`);
}

function removeSourceAttributes(html: string): string {
  return html
    .replaceAll(/\sclass="[^"]*"/g, '')
    .replaceAll(/\sdata-sentry-[a-z-]+="[^"]*"/g, '')
    .replaceAll(/\sstyle="[^"]*"/g, '');
}

export function extractTermsMainHtml(html: string): string {
  const match = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  if (!match?.[1]) {
    throw new Error('Could not find terms content.');
  }

  return removeSourceAttributes(absolutizeKiloLinks(match[1])).trim();
}

export async function fetchTermsMainHtml(): Promise<string> {
  try {
    const response = await fetch(TERMS_SOURCE_URL, {
      next: { revalidate: 3600 },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch terms: ${response.status}`);
    }

    return extractTermsMainHtml(await response.text());
  } catch {
    return TERMS_FALLBACK_HTML;
  }
}
