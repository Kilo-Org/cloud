import { NextResponse, type NextRequest } from 'next/server';

import {
  PR_REVIEW_REDIRECT_STATUS,
  resolvePrReviewTarget,
  type PrReviewTarget,
} from './resolve-pr-review-target';

// Deliberate status: the mapping is a convenience to the provider page, not a
// permanent home for the URL. A 308 sticks in browsers forever, so a mapping
// fix or a provider rename would leave visitors following a cached wrong
// answer; 307 is repeatable and still keeps the request a GET.
const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store',
  // PR titles and repositories are private; never index or archive these.
  'X-Robots-Tag': 'noindex, noarchive, nofollow',
} as const;

function notFoundResponse(): NextResponse {
  return new NextResponse('Not Found', {
    status: 404,
    headers: { ...NO_STORE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * The page for a host we will not auto-navigate to. It renders one link and
 * nothing else; every value in it is escaped, and the link carries
 * `rel="noopener noreferrer"` so the destination cannot reach back here.
 */
function confirmResponse(target: Extract<PrReviewTarget, { kind: 'confirm' }>): NextResponse {
  const url = escapeHtml(target.url);
  const host = escapeHtml(target.host);
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, noarchive, nofollow">
<title>Continue to ${host}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 0; display: flex; min-height: 100vh; align-items: center; justify-content: center; padding: 24px; }
  main { max-width: 32rem; }
  p { line-height: 1.5; }
  a { font-weight: 600; }
</style>
</head>
<body>
<main>
<h1>Continue to ${host}</h1>
<p>This review lives on a self-managed GitLab instance. Kilo does not redirect to that host automatically.</p>
<p><a href="${url}" rel="noopener noreferrer">Open the merge request on ${host}</a></p>
</main>
</body>
</html>`;
  return new NextResponse(html, {
    status: 200,
    headers: { ...NO_STORE_HEADERS, 'Content-Type': 'text/html; charset=utf-8' },
  });
}

export const dynamic = 'force-dynamic';

/**
 * `/pr-review/...` is a mobile universal link with no web surface. This route
 * sends a visitor to the provider's own review page instead of the 404 they
 * used to get. It performs no authenticated read, so it needs no sign-in.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> }
): Promise<NextResponse> {
  const { path } = await context.params;
  const target = resolvePrReviewTarget({
    path,
    instance: request.nextUrl.searchParams.get('instance'),
  });

  if (target === null) {
    return notFoundResponse();
  }
  if (target.kind === 'confirm') {
    return confirmResponse(target);
  }
  return new NextResponse(null, {
    status: PR_REVIEW_REDIRECT_STATUS,
    headers: { ...NO_STORE_HEADERS, Location: target.url },
  });
}

/**
 * Browsers, link previewers and `curl -I` check these links with HEAD; the
 * mapping is the same, and the server sends no body for a HEAD response.
 */
export const HEAD = GET;
