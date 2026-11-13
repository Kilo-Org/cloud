/**
 * The caller address a Vercel Firewall rule counts against: the address the
 * platform observed (`x-vercel-forwarded-for`), then `x-real-ip`, then
 * `'unknown'`, which keeps the rule key non-empty when neither header has a
 * usable hop. Every caller-keyed sign-in budget reads the address here, so one
 * caller lands in one bucket and the answers cannot disagree.
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
