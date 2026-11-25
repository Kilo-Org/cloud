import { getWorkerDb } from '@kilocode/db/client';
import { cloud_agent_code_reviews as reviews } from '@kilocode/db/schema';
import { decryptWithSymmetricKey, encryptWithSymmetricKey } from '@kilocode/encryption';
import {
  reviewCapabilityPrefix,
  type CapabilityPurpose,
  type ScopeReviewCapabilityParams,
} from '@kilocode/worker-utils/scm-capability-contract';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { BitbucketSessionCapabilityCodec } from './bitbucket-session-capability.js';
import { GitHubSessionCapabilityCodec } from './github-session-capability.js';
import { GitLabSessionCapabilityCodec } from './gitlab-session-capability.js';

const envelopeSchema = z
  .object({
    purpose: z.literal('scm_code_review'),
    provider: z.enum(['github', 'gitlab', 'bitbucket']),
    capability: z.string().min(1),
    gitUrl: z.url(),
    apiRoot: z.url(),
    number: z.number().int().positive().nullable(),
    head: z.string(),
    botId: z.string().optional(),
    repositoryUuid: z.string().optional(),
    projectId: z.number().int().positive().optional(),
  })
  .strict();

export type ReviewCapability = z.infer<typeof envelopeSchema>;

export function openReviewCapability(provider: CapabilityPurpose, capability: string, key: string) {
  const prefix = reviewCapabilityPrefix(provider);
  if (!capability.startsWith(prefix)) throw new Error('Invalid review credential');
  const value = envelopeSchema.parse(
    JSON.parse(decryptWithSymmetricKey(capability.slice(prefix.length), key))
  );
  if (value.provider !== provider) throw new Error('Invalid review provider');
  return value;
}

function repositorySubject(env: CloudflareEnv, params: ScopeReviewCapabilityParams, key: string) {
  const { provider, capability } = params;
  if (provider === 'github') {
    const claims = new GitHubSessionCapabilityCodec(key).decode(capability);
    if (claims.version !== 2 || claims.source !== 'installation')
      throw new Error('Review requires installation access');
    const repo = claims.owner + '/' + claims.repo;
    const botId =
      claims.identity.appType === 'lite'
        ? env.GITHUB_LITE_APP_BOT_USER_ID
        : env.GITHUB_APP_BOT_USER_ID;
    return {
      claims,
      repo,
      gitUrl: 'https://github.com/' + repo + '.git',
      apiRoot: 'https://api.github.com/repos/' + repo,
      botId,
    };
  }
  if (provider === 'bitbucket') {
    const claims = new BitbucketSessionCapabilityCodec(key).decode(capability);
    if (claims.oauthCredentialId) throw new Error('Review requires workspace access');
    const repo = claims.repositoryFullName;
    return {
      claims,
      repo,
      gitUrl: 'https://bitbucket.org/' + repo + '.git',
      apiRoot: 'https://api.bitbucket.org/2.0/repositories/' + repo,
      repositoryUuid: claims.repositoryUuid,
    };
  }
  const claims = new GitLabSessionCapabilityCodec(key).decode(capability);
  if (claims.source.type !== 'project') throw new Error('Review requires project access');
  const repo = claims.projectPath;
  return {
    claims,
    repo,
    gitUrl: claims.instanceOrigin + '/' + repo + '.git',
    apiRoot: claims.instanceOrigin + '/api/v4/projects/' + encodeURIComponent(repo),
    projectId: claims.source.projectId,
  };
}

export async function scopeReviewCapability(
  env: CloudflareEnv,
  params: ScopeReviewCapabilityParams,
  key: string
) {
  const { claims, repo, ...target } = repositorySubject(env, params, key);
  const db = getWorkerDb(env.HYPERDRIVE.connectionString, { statement_timeout: 10_000 });
  const rows = await db
    .select({
      number: reviews.pr_number,
      head: reviews.head_sha,
      repository: reviews.repo_full_name,
      platform: reviews.platform,
      integrationId: reviews.platform_integration_id,
    })
    .from(reviews)
    .where(
      and(
        params.reviewId
          ? eq(reviews.id, params.reviewId)
          : eq(reviews.session_id, params.sessionId),
        claims.orgId
          ? eq(reviews.owned_by_organization_id, claims.orgId)
          : eq(reviews.owned_by_user_id, claims.userId)
      )
    )
    .limit(2);
  const review = rows[0];
  if (
    rows.length !== 1 ||
    !review ||
    (!params.additional &&
      (review.platform !== params.provider ||
        review.repository.toLowerCase() !== repo.toLowerCase() ||
        (claims.integrationId && review.integrationId !== claims.integrationId)))
  )
    throw new Error('Review assignment unavailable');
  const value = envelopeSchema.parse({
    purpose: 'scm_code_review',
    provider: params.provider,
    capability: params.capability,
    ...target,
    number: params.additional ? null : review.number,
    head: review.head,
  });
  return (
    reviewCapabilityPrefix(params.provider) + encryptWithSymmetricKey(JSON.stringify(value), key)
  );
}
