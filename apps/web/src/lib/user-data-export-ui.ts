import 'server-only';

import { isReleaseToggleEnabled } from '@kilocode/web-shared/lib/posthog-feature-flags';

export async function isCloudDataExportUIEnabled(email: string): Promise<boolean> {
  if (!email) return false;

  // A local stack has no PostHog flags to answer this, so every preview of the
  // screens behind the toggle would render the unavailable state. Only a
  // development build reaches this branch: the release toggle keeps its strict
  // boolean-only evaluation everywhere it decides what a real user can see.
  if (process.env.NODE_ENV === 'development') return true;

  return isReleaseToggleEnabled('cloud-data-export-ui', email);
}
