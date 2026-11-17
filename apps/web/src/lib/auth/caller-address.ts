import { firstForwardedHop } from '@kilocode/web-shared/lib/http/forwarded-hop';

/**
 * The caller address the platform labelled the request with: the first hop of
 * `x-vercel-forwarded-for`, then of `x-real-ip`, which the platform sets on a
 * request it serves. Null when neither header carries a usable hop, so a
 * caller that must tell "no address" from a real one keeps that distinction.
 */
export function callerAddressOrNull(headers: Headers): string | null {
  return (
    firstForwardedHop(headers.get('x-vercel-forwarded-for')) ??
    firstForwardedHop(headers.get('x-real-ip'))
  );
}

/**
 * The caller address a Vercel Firewall rule counts against: the platform
 * address above, then `'unknown'`, which keeps the rule key non-empty when
 * neither header has a usable hop.
 */
export function callerAddressFromHeaders(headers: Headers): string {
  return callerAddressOrNull(headers) ?? 'unknown';
}
