import { extractLegalMainHtml } from '@/app/legal-page-source';

export const TERMS_SOURCE_URL = 'https://kilo.ai/terms';

const TERMS_CONTACT_EMAIL = ['support', 'kilo.ai'].join('@');

export const TERMS_FALLBACK_HTML = `
<h1>Terms of Use</h1>
<p>The full Kilo terms are temporarily unavailable. Please try again shortly.</p>
<p>For terms questions, contact <a href="mailto:${TERMS_CONTACT_EMAIL}">${TERMS_CONTACT_EMAIL}</a>.</p>
`.trim();

export function extractTermsMainHtml(html: string): string {
  return extractLegalMainHtml({
    html,
    sourceUrl: TERMS_SOURCE_URL,
    missingMessage: 'Could not find terms content.',
  });
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
