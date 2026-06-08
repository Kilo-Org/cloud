import { extractLegalMainHtml } from '@/app/legal-page-source';

export const PRIVACY_POLICY_SOURCE_URL = 'https://kilo.ai/privacy';

const PRIVACY_CONTACT_EMAIL = ['support', 'kilo.ai'].join('@');

export const PRIVACY_POLICY_FALLBACK_HTML = `
<h1>Privacy Policy</h1>
<p>The full Kilo privacy policy is temporarily unavailable. Please try again shortly.</p>
<p>For privacy questions or requests, contact <a href="mailto:${PRIVACY_CONTACT_EMAIL}">${PRIVACY_CONTACT_EMAIL}</a>.</p>
`.trim();

export function extractPrivacyPolicyMainHtml(html: string): string {
  return extractLegalMainHtml({
    html,
    sourceUrl: PRIVACY_POLICY_SOURCE_URL,
    missingMessage: 'Could not find privacy policy content.',
  });
}

export async function fetchPrivacyPolicyMainHtml(): Promise<string> {
  try {
    const response = await fetch(PRIVACY_POLICY_SOURCE_URL, {
      next: { revalidate: 3600 },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch privacy policy: ${response.status}`);
    }

    return extractPrivacyPolicyMainHtml(await response.text());
  } catch {
    return PRIVACY_POLICY_FALLBACK_HTML;
  }
}
