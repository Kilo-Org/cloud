// Pure provider write primitives shared by every `providerReview` mutation hook
// (s6): the identity object a mutation input carries and the fingerprint input
// the server hashes into `resource_key`. This module has no React dependency,
// so the merge and discussion hooks reach these builders without loading the
// review-mutation hook module.

import { type BitbucketPrRef, type GitLabMrRef } from '@kilocode/app-shared/provider-review';

import { type ProviderPrScope } from '@/lib/pr-review/provider-pr-ref';

/**
 * The provider write identity every `providerReview` mutation input carries.
 * Mirrors `providerIdentity()` in `provider-pr-queries.ts` exactly, so the
 * invalidation keys hit the same cache entries the reads populate.
 */
export type ProviderWriteIdentity =
  | {
      platform: 'gitlab';
      projectPath: string;
      mrIid: number;
      instanceHint?: string;
      organizationId?: string;
    }
  | {
      platform: 'bitbucket';
      workspace: string;
      repoSlug: string;
      prId: number;
      organizationId: string;
    };

/** The mutation-side identity of one scope — the read-side twin, unchanged. */
export function providerWriteIdentity(scope: ProviderPrScope): ProviderWriteIdentity {
  const { ref, organizationId } = scope;
  if (ref.platform === 'gitlab') {
    return {
      platform: 'gitlab',
      projectPath: ref.projectPath,
      mrIid: ref.mrIid,
      ...(ref.instanceHint ? { instanceHint: ref.instanceHint } : {}),
      ...(organizationId ? { organizationId } : {}),
    };
  }
  return {
    platform: 'bitbucket',
    workspace: ref.platform === 'bitbucket' ? ref.workspace : '',
    repoSlug: ref.platform === 'bitbucket' ? ref.repoSlug : '',
    prId: ref.platform === 'bitbucket' ? ref.prId : 0,
    organizationId: organizationId ?? '',
  };
}

/**
 * The fingerprint input the server hashes into `resource_key`: the s1
 * provider identity fields (`gitlabFingerprintInput` /
 * `bitbucketFingerprintInput` in provider-review-router.ts) plus the
 * intent-defining fields. Field VALUES must match the server's — the
 * fingerprint is the dedupe identity, and a drift makes every same-key
 * retry fail with `operation_key_reuse_mismatch`.
 */
export function providerFingerprintInput(
  ref: GitLabMrRef | BitbucketPrRef,
  fields: Record<string, unknown>
) {
  if (ref.platform === 'gitlab') {
    return {
      platform: 'gitlab',
      projectPath: ref.projectPath,
      instanceHint: ref.instanceHint,
      number: ref.mrIid,
      ...fields,
    };
  }
  return {
    platform: 'bitbucket',
    workspace: ref.workspace,
    repoSlug: ref.repoSlug,
    number: ref.prId,
    ...fields,
  };
}
