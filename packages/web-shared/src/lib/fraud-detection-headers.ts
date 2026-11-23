/**
 * A finite decimal header value, or `null` when the header is absent, blank, or carries
 * trailing text. `Number` is used instead of `parseFloat`, which would silently drop that
 * trailing text and put a truncated coordinate in a field typed `number | null`.
 */
const parseFiniteDecimalOrNull = (value: string | null): number | null => {
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
    http_x_vercel_ip_latitude: parseFiniteDecimalOrNull(headers.get('x-vercel-ip-latitude')),
    http_x_vercel_ip_longitude: parseFiniteDecimalOrNull(headers.get('x-vercel-ip-longitude')),
    http_x_vercel_ja4_digest: headers.get('x-vercel-ja4-digest'),
    http_user_agent: headers.get('user-agent'),
  };
}
