import { captureException } from '@sentry/nextjs';
import { NextResponse } from 'next/server';

import { withRestTiming } from '@kilocode/web-shared/lib/observability/request-timing';

import { stripLeadingDocumentTitle } from '@/app/legal-body';
import { loadPrivacyPolicyMainHtml } from '@/app/privacy-app/privacy-policy-source';
import { loadTermsMainHtml } from '@/app/terms-app/terms-source';

// The two documents the mobile app renders in its own screens. Each loader
// throws when the marketing-site source cannot be read, so the app can tell a
// retryable outage (5xx) from a request it must not retry (404).
const LEGAL_DOCUMENTS = {
  terms: loadTermsMainHtml,
  privacy: loadPrivacyPolicyMainHtml,
} as const satisfies Record<string, () => Promise<string>>;

type LegalDocumentName = keyof typeof LEGAL_DOCUMENTS;

function isLegalDocumentName(value: string): value is LegalDocumentName {
  return value === 'terms' || value === 'privacy';
}

// The mobile reader renders the document title in its own header, so the served
// body starts at the document content: the response drops whichever heading the
// sanitized body opens with, along with wrappers that heading leaves empty. The
// web fallback pages keep their own titles, and a body that does not lead with a
// heading is served byte-for-byte as loaded.
export const GET = withRestTiming(
  '/api/legal',
  async (_request: Request, context?: { params: Promise<{ document: string }> }) => {
    const { document } = (await context?.params) ?? { document: '' };

    if (!isLegalDocumentName(document)) {
      return NextResponse.json({ error: 'Unknown legal document' }, { status: 404 });
    }

    try {
      const html = await LEGAL_DOCUMENTS[document]();
      return NextResponse.json(
        { html: stripLeadingDocumentTitle(html) },
        { headers: { 'Cache-Control': 'public, max-age=300' } }
      );
    } catch (error) {
      captureException(error);
      return NextResponse.json({ error: 'Legal document unavailable' }, { status: 502 });
    }
  }
);
