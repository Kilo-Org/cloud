const parseFloatOrNull = (value: string | null) => (value === null ? null : parseFloat(value));
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
