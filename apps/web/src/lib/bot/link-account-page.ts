/**
 * HTML pages shared by the chat account-link flow: the confirmation page and
 * the result pages rendered by `/api/chat/link-account` and by the platform
 * OAuth callback that completes the identity proof.
 */

export const LINK_ACCOUNT_PATH = '/api/chat/link-account';

const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  // The page's only action is a form posted back to this route, and the link
  // token travels in the page URL, so the page declares the origins a form
  // submission may reach and asks intermediaries not to store, embed, sniff,
  // or forward it. `form-action` also governs the redirects of a form
  // submission, and the identity proof continues to Slack from that POST, so
  // Slack is the one additional origin the submission may reach.
  //
  // The apex and the wildcard are both required: a host source without a
  // wildcard does not match subdomains, and `*.slack.com` does not match
  // `slack.com` itself. The sign-in endpoint is on the apex today, but Slack
  // routes some sign-in hops through a workspace or `app.` subdomain, and a
  // blocked hop shows the user a CSP error instead of the sign-in page.
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://slack.com https://*.slack.com; frame-ancestors 'none'; base-uri 'none'",
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
} as const;

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function page(title: string, body: string, status = 200): Response {
  return new Response(
    `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body style="font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div style="text-align:center">
  <h1>${escapeHtml(title)}</h1>
${body}
</div>
</body></html>`,
    { status, headers: PAGE_HEADERS }
  );
}

export function errorPage(title: string, message: string, status: number): Response {
  return page(title, `  <p>${escapeHtml(message)}</p>`, status);
}

export function linkConflictPage(platform: string): Response {
  return errorPage(
    'Already linked',
    `This ${platform} account is already linked to a different Kilo account. No changes were made. ` +
      `Sign in to the Kilo account that already holds it, then request a new link from your chat. ` +
      `If you cannot sign in to that account, a workspace owner or admin can disconnect the ` +
      `${platform} integration and connect it again, which clears the links held for that workspace.`,
    409
  );
}

export function linkUsedPage(): Response {
  return errorPage(
    'Link Already Used',
    'This link has already been used. Please go back to your chat and mention Kilo again to get a new link.',
    400
  );
}
