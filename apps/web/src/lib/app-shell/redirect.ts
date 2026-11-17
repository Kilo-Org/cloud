import { NextResponse } from 'next/server';

/**
 * Redirect to a shell path on whatever origin the browser is actually using.
 *
 * Deliberately NOT `NextResponse.redirect(new URL(path, request.url))`: the dev
 * server binds 0.0.0.0, so `request.url` reports that origin even when the
 * browser is on localhost or a LAN address. Redirecting there is a cross-origin
 * hop, so the shell cookie — stored for the host the browser actually requested
 * — is never sent, and the hand-off lands on the terminal "expired" page. A
 * relative `Location` is resolved by the browser against the current origin, so
 * the host that was requested stays the host of every shell page.
 */
export function appShellRedirect(pathWithQuery: string, status: 302 | 303 | 307 = 307) {
  return new NextResponse(null, {
    status,
    headers: { Location: pathWithQuery, 'Cache-Control': 'no-store' },
  });
}
