/**
 * The usable first hop of a forwarding header, or null when the header is
 * absent or its first entry is empty.
 *
 * `Headers.get` answers `null` for an absent header, and a stub or a hand-built
 * header map can answer `undefined`; both mean "no hop".
 *
 * Each caller decides which headers it reads and in what order: the audit
 * attribution prefers the platform-observed `x-vercel-forwarded-for` then
 * `x-forwarded-for`, the firewall caller address prefers
 * `x-vercel-forwarded-for` then `x-real-ip`.
 */
export function firstForwardedHop(forwarded: string | null | undefined): string | null {
  if (forwarded === null || forwarded === undefined) return null;
  const first = forwarded.split(',')[0]?.trim();
  return first === undefined || first === '' ? null : first;
}
