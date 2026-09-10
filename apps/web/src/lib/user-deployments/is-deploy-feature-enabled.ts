import 'server-only';

import type { Owner } from '@/lib/integrations/core/types';
import { isFeatureFlagEnabled } from '@/lib/posthog-feature-flags';
import { hasExistingDeployments } from '@/lib/user-deployments/deployments-service';
import {
  DEPLOY_FEATURE_FLAG,
  shouldShowDeployFeature,
} from '@/lib/user-deployments/feature-access';

export async function isDeployFeatureEnabled(userId: string, owner: Owner): Promise<boolean> {
  const isDevelopment = process.env.NODE_ENV === 'development';
  if (isDevelopment) {
    return true;
  }

  const [isFlagEnabled, hasExisting] = await Promise.all([
    isFeatureFlagEnabled(DEPLOY_FEATURE_FLAG, userId),
    hasExistingDeployments(owner),
  ]);

  return shouldShowDeployFeature({
    isDevelopment: false,
    isFlagEnabled,
    hasExistingDeployments: hasExisting,
  });
}
