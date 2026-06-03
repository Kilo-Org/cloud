export const PRIVACY_POLICY_SOURCE_URL = 'https://kilo.ai/privacy';

function absolutizeKiloLinks(html: string): string {
  return html.replaceAll(/(href|src)="\/(?!\/)/g, `$1="${new URL('/', PRIVACY_POLICY_SOURCE_URL)}`);
}

function removeSourceAttributes(html: string): string {
  return html
    .replaceAll(/\sclass="[^"]*"/g, '')
    .replaceAll(/\sdata-sentry-[a-z-]+="[^"]*"/g, '')
    .replaceAll(/\sstyle="[^"]*"/g, '');
}

export function extractPrivacyPolicyMainHtml(html: string): string {
  const match = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  if (!match?.[1]) {
    throw new Error('Could not find privacy policy content.');
  }

  return removeSourceAttributes(absolutizeKiloLinks(match[1])).trim();
}

export async function fetchPrivacyPolicyMainHtml(): Promise<string> {
  const response = await fetch(PRIVACY_POLICY_SOURCE_URL, {
    next: { revalidate: 3600 },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch privacy policy: ${response.status}`);
  }

  return extractPrivacyPolicyMainHtml(await response.text());
}
