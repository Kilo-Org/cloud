import { z } from 'zod';

export const CodeReviewProviderFailureReasonSchema = z.enum([
  'byok_invalid_key',
  'selected_model_unavailable',
]);
export type CodeReviewProviderFailureReason = z.infer<typeof CodeReviewProviderFailureReasonSchema>;

const BYOK_INVALID_KEY_MESSAGE =
  '[byok] your api key is invalid or has been revoked. please check your api key configuration.';
const BYOK_PERMISSION_DENIED_MESSAGE =
  '[byok] your api key does not have permission to access this resource. please check your api key permissions.';

export function classifyCodeReviewProviderFailure(
  errorMessage?: string | null
): CodeReviewProviderFailureReason | null {
  if (!errorMessage) return null;
  const normalized = errorMessage.toLowerCase();
  if (
    normalized.includes(BYOK_INVALID_KEY_MESSAGE) ||
    normalized.includes(BYOK_PERMISSION_DENIED_MESSAGE)
  ) {
    return 'byok_invalid_key';
  }
  if (
    normalized.includes('selected model is not available for this cloud agent session') ||
    normalized.includes('the requested model is not allowed for your team') ||
    normalized.includes('provider_not_allowed') ||
    normalized.includes('no eligible provider can serve the selected model.') ||
    normalized.includes('no allowed providers are specified.') ||
    normalized.includes('no allowed providers are available for the selected model.') ||
    normalized.includes('no endpoints found matching your data policy')
  ) {
    return 'selected_model_unavailable';
  }
  return null;
}
