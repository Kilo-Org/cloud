import { type LegalDocument } from '@/lib/legal-document';

/**
 * What the legal screen does with a link in a document's own content.
 * `handled` means this screen consumed the press and nothing else may run:
 * an in-page anchor (`#section`) has no destination this renderer can scroll
 * to, and sending it to the external-link flow would show its "Could not open
 * link" error instead. The document's own absolute URL is the same case.
 * `open` is the cross reference to the other legal document. `external` leaves
 * the link to the renderer's normal flow.
 */
export type LegalInContentLinkPlan =
  | { readonly kind: 'handled' }
  | { readonly kind: 'open'; readonly document: LegalDocument }
  | { readonly kind: 'external' };

export function planLegalInContentLink(
  href: string,
  document: LegalDocument
): LegalInContentLinkPlan {
  if (href.startsWith('#')) {
    return { kind: 'handled' };
  }

  const target = legalDocumentForLink(href);
  if (target === null) {
    return { kind: 'external' };
  }

  return target === document ? { kind: 'handled' } : { kind: 'open', document: target };
}

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
