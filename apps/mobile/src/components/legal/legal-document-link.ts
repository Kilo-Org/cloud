import { type LegalDocument } from '@/lib/legal-document';

/**
 * The legal document a kilo.ai link points at. Anything else — another host, or
 * a kilo.ai marketing page the sanitized content no longer links to — is not
 * ours to handle, and the renderer's normal flow applies.
 */
export function legalDocumentForLink(href: string): LegalDocument | null {
  const url = parseAbsoluteUrl(href);
  if (url === null) {
    return null;
  }

  if (url.hostname !== 'kilo.ai' && url.hostname !== 'www.kilo.ai') {
    return null;
  }

  if (url.pathname === '/terms' || url.pathname.startsWith('/terms/')) {
    return 'terms';
  }

  if (url.pathname === '/privacy' || url.pathname.startsWith('/privacy/')) {
    return 'privacy';
  }

  return null;
}

/** Parses an absolute link, or reports the target as one this screen does not own. */
function parseAbsoluteUrl(href: string): URL | null {
  try {
    return new URL(href);
  } catch {
    return null;
  }
}
