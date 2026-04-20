import {
  mergeProfileConfiguration,
  type MergeProfileConfigurationResult,
} from '@/lib/agent/profile-session-config';
import type { ProfileOwner } from '@/lib/agent/types';
import type { OwnerRef } from './resolve-platform-integration-owner';

export type BotSessionProfileArgs = {
  githubRepo?: string;
  gitlabProject?: string;
};

/**
 * Resolve the effective profile configuration for a Cloud Agent session
 * spawned by a bot (Slack/Discord/etc.).
 *
 * Applies the same layering the web tRPC routers apply:
 *   - Layer 1: repo-binding profile (if any)
 *   - Layer 2: owner's default profile (effective default for orgs)
 *
 * The bot never supplies a `profileName`, so the explicit-name resolution path
 * in `mergeProfileConfiguration` is not used.
 */
export async function resolveBotSessionProfile(
  ownerRef: OwnerRef,
  ticketUserId: string,
  args: BotSessionProfileArgs
): Promise<MergeProfileConfigurationResult> {
  const owner: ProfileOwner =
    ownerRef.kind === 'org'
      ? { type: 'organization', id: ownerRef.id }
      : { type: 'user', id: ownerRef.id };
  const userIdForMerge = ownerRef.kind === 'org' ? ticketUserId : undefined;

  const repoFullName = args.gitlabProject ?? args.githubRepo;
  const platform: 'github' | 'gitlab' = args.gitlabProject ? 'gitlab' : 'github';

  return mergeProfileConfiguration({
    owner,
    userId: userIdForMerge,
    repoFullName,
    platform,
  });
}
