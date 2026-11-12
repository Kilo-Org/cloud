import 'server-only';

import { isReleaseToggleEnabled } from '@kilocode/web-shared/lib/posthog-feature-flags';

export async function isCloudDataExportUIEnabled(email: string): Promise<boolean> {
  if (!email) return false;

  return isReleaseToggleEnabled('cloud-data-export-ui', email);
}
