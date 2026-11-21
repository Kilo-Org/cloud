import { type LegalDocument } from '@/lib/legal-document';

/** The route names its document; anything else falls back to the terms page. */
export function legalDocumentFromParam(value: string | undefined): LegalDocument {
  return value === 'privacy' ? 'privacy' : 'terms';
}
