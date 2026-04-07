import { isFeatureFlagEnabled } from '@/lib/posthog-feature-flags';

const APPLE_SIGN_IN_FLAG = 'apple-sign-in';

export async function isAppleSignInEnabled(): Promise<boolean> {
  if (process.env.NODE_ENV !== 'production') return true;
  return isFeatureFlagEnabled(APPLE_SIGN_IN_FLAG);
}
