import { captureException } from '@sentry/nextjs';
import { NextResponse } from 'next/server';

import { withRestTiming } from '@kilocode/web-shared/lib/observability/request-timing';

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
// body starts after the source page's title heading. The web fallback pages keep
// their H1; only this API response drops it. A document that does not open with
// an H1 element is served unchanged.
const LEADING_TITLE_HEADING = /^\s*<h1\b[^>]*>[\s\S]*?<\/h1>/i;

export function stripLeadingTitleHeading(html: string): string {
  // Non-greedy is safe: sanitize-html escapes `<` in text and attribute values,
  // so `</h1>` cannot occur inside the element and the first one closes it.
  return html.replace(LEADING_TITLE_HEADING, '');
}

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
        { html: stripLeadingTitleHeading(html) },
        { headers: { 'Cache-Control': 'public, max-age=300' } }
      );
    } catch (error) {
      captureException(error);
      return NextResponse.json({ error: 'Legal document unavailable' }, { status: 502 });
    }
  }
);
