import type { CodeReviewPlatform } from '@/lib/code-reviews/core/schemas';
import { PLATFORM } from '@/lib/integrations/core/constants';

type PlatformConfig = {
  prTerm: 'PR' | 'MR';
};

const platformConfigs = {
  [PLATFORM.GITHUB]: { prTerm: 'PR' },
  [PLATFORM.GITLAB]: { prTerm: 'MR' },
} satisfies Record<CodeReviewPlatform, PlatformConfig>;

export function getPlatformConfig(platform: CodeReviewPlatform): PlatformConfig {
  return platformConfigs[platform];
}
