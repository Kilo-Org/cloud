import 'server-only';
import { getDomain } from 'tldts';

/**
 * Extracts the registrable domain (eTLD+1) from an email address, using the
 * Public Suffix List via `tldts`. This is what we store in
 * `kilocode_users.email_domain`.
 *
 * - `alice@example.com`           → `example.com`
 * - `alice@mail.example.com`      → `example.com`
 * - `alice@foo.bar.example.co.uk` → `example.co.uk`
 *
 * `allowPrivateDomains: true` so hosts on private suffixes like
 * `*.vercel.app`, `*.github.io`, `*.s3.amazonaws.com` resolve to the
 * per-tenant subdomain (e.g. `user.vercel.app`) rather than collapsing every
 * tenant to `vercel.app` — preferable for admin abuse-pattern grouping.
 *
 * When tldts still can't resolve a registrable domain (IP literals, bare
 * single-label hosts), falls back to `<raw-host>.invalid` using the RFC 2606
 * reserved TLD, so the result is always non-null for any email containing
 * `@<something>`. Fallback rows are obvious in admin/SQL inspection
 * (`WHERE email_domain LIKE '%.invalid'`).
 *
 * Returns null only for inputs without an `@` or with an empty domain part.
 *
 * Server-only: `tldts` ships a ~3 MB Public Suffix List and must not be
 * pulled into client bundles. Do not import this from code that runs in
 * the browser.
 *
 * NOTE: The bundled PSL is a point-in-time snapshot. Keeping `tldts` up to
 * date via regular dependency bumps keeps domain classification current.
 * This column is used for admin grouping/queries only — not as a security
 * boundary — so a stale PSL is low-impact.
 */
export function extractEmailDomain(email: string): string | null {
  const atIndex = email.lastIndexOf('@');
  if (atIndex === -1) return null;
  const host = email.slice(atIndex + 1).toLowerCase();
  if (host.length === 0) return null;
  const registrable = getDomain(host, { allowPrivateDomains: true });
  if (registrable !== null) return registrable;
  return `${host}.invalid`;
}
