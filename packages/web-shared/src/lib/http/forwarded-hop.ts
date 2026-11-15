/**
 * The usable first hop of a forwarding header, or null when the header is
 * absent or its first entry is empty.
 *
 * Each caller decides which headers it reads and in what order: the audit
 * attribution prefers the platform-observed `x-vercel-forwarded-for` then
 * `x-forwarded-for`, the firewall caller address prefers
 * `x-vercel-forwarded-for` then `x-real-ip`.
 */
export function firstForwardedHop(forwarded: string | null): string | null {
  if (forwarded === null) return null;
  const first = forwarded.split(',')[0]?.trim();
  return first === undefined || first === '' ? null : first;
}
