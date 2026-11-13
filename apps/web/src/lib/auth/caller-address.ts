/**
 * The caller address a Vercel Firewall rule counts against.
 *
 * `x-vercel-forwarded-for` holds the address the platform observed, so it is
 * read first: the generic forwarding header can be written by a proxy in front
 * of the platform, and a caller that chooses it also chooses its own bucket.
 * `x-real-ip` covers a request the platform labelled with that header alone,
 * and `'unknown'` keeps the rule key non-empty when neither header has a usable
 * hop.
 */
export function callerAddressFromHeaders(headers: Headers): string {
  return (
    firstForwardedHop(headers.get('x-vercel-forwarded-for')) ??
    firstForwardedHop(headers.get('x-real-ip')) ??
    'unknown'
  );
}

/** The first entry of a forwarding header, or null when it is absent or empty. */
function firstForwardedHop(value: string | null): string | null {
  const hop = value?.split(',')[0]?.trim();
  return hop ? hop : null;
}
