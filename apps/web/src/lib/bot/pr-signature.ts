import type { RequesterInfo } from '@/lib/bot/platforms';
import { PLATFORM, type Platform } from '@/lib/integrations/core/constants';

const PLATFORM_LINKS: Partial<Record<Platform, { label: string; url: string }>> = {
  [PLATFORM.SLACK]: { label: 'Kilo for Slack', url: 'https://kilo.ai/slack' },
};

const DEFAULT_PLATFORM_LINK = { label: 'Kilo', url: 'https://kilo.ai' };

/**
 * Build the PR signature instruction to append to the Cloud Agent prompt.
 * Instructs the agent to include a "Built for ..." line at the end of any
 * PR/MR description it creates.
 */
export function buildPrSignature(requesterInfo: RequesterInfo): string {
  const requesterPart = requesterInfo.messageLink
    ? `[${requesterInfo.displayName}](${requesterInfo.messageLink})`
    : requesterInfo.displayName;

  const { label, url } = PLATFORM_LINKS[requesterInfo.platform] ?? DEFAULT_PLATFORM_LINK;

  return `

---
**PR Signature to include in the PR description:**
If you create a pull request or merge request, include the following signature at the end of the PR/MR description:

Built for ${requesterPart} by [${label}](${url})`;
}
