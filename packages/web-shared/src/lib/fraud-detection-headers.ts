/**
 * A decimal header value, or `null` when the header is absent or holds no complete finite
 * number. `Number` rejects trailing text, which `parseFloat` silently drops, so a malformed
 * coordinate becomes `null` like an absent one instead of `NaN` in a field typed `number | null`.
 */
const parseFloatOrNull = (value: string | null): number | null => {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
};
export const EmptyFraudDetectionHeaders = getFraudDetectionHeaders(new Headers());
export type FraudDetectionHeaders = ReturnType<typeof getFraudDetectionHeaders>;
export function getFraudDetectionHeaders(headers: Headers) {
  return {
    http_x_forwarded_for: headers.get('x-forwarded-for'),
    http_x_vercel_ip_city: headers.get('x-vercel-ip-city'),
    http_x_vercel_ip_country: headers.get('x-vercel-ip-country'),
    http_x_vercel_ip_latitude: parseFloatOrNull(headers.get('x-vercel-ip-latitude')),
    http_x_vercel_ip_longitude: parseFloatOrNull(headers.get('x-vercel-ip-longitude')),
    http_x_vercel_ja4_digest: headers.get('x-vercel-ja4-digest'),
    http_user_agent: headers.get('user-agent'),
  };
}
