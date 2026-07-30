export function getTrustedClientIp(headers: Headers): string | null {
  // Vercel overwrites this header at the edge, unlike generic forwarded headers.
  return headers.get('x-vercel-forwarded-for')?.split(',')[0]?.trim() || null;
}
