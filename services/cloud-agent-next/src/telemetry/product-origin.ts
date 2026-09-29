/**
 * Classifies a trusted `billingOrigin` for the reporting tables. Only the
 * billing origin is trusted; `createdOnPlatform` and
 * `cli_sessions_v2.created_on_platform` are caller-controlled strings.
 */
export function reportingProductOrigin(
  billingOrigin: string | undefined
): 'code-review' | 'other' | null {
  if (billingOrigin === undefined || billingOrigin === '') return null;
  return billingOrigin === 'code-review' ? 'code-review' : 'other';
}
