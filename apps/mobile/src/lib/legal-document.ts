import * as z from 'zod';

import { API_BASE_URL } from '@/lib/config';

/** The two documents apps/web serves at /terms-app and /privacy-app. */
export type LegalDocument = 'terms' | 'privacy';

export type LegalDocumentFailure =
  /** A network fault or a server-side outage: asking again can succeed. */
  | 'retryable'
  /** The server refused this document or answered with something unusable. */
  | 'unavailable';

export type LegalDocumentResult =
  | { kind: 'loaded'; html: string }
  | { kind: 'failed'; failure: LegalDocumentFailure };

const legalDocumentBodySchema = z.object({ html: z.string() });

/** What an unreadable answer and a transport failure share: nothing to render. */
const UNREADABLE: LegalDocumentResult = { kind: 'failed', failure: 'retryable' };

/**
 * Reads one legal document from the app API. The route answers 502 when the
 * upstream source is down and 404 for a name it does not serve, which is what
 * separates a retry from a dead end on the screen.
 */
export async function loadLegalDocument(
  document: LegalDocument,
  signal: AbortSignal
): Promise<LegalDocumentResult> {
  const response = await fetch(`${API_BASE_URL}/api/legal/${document}`, { signal }).catch(
    () => null
  );

  if (response === null) {
    return UNREADABLE;
  }

  if (!response.ok) {
    return {
      kind: 'failed',
      failure: response.status >= 500 ? 'retryable' : 'unavailable',
    };
  }

  const body = await response.json().catch(() => undefined);
  const parsed = legalDocumentBodySchema.safeParse(body);
  if (!parsed.success || parsed.data.html.trim() === '') {
    return UNREADABLE;
  }

  return { kind: 'loaded', html: parsed.data.html };
}
