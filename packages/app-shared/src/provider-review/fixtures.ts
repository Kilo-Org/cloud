import type { CodeReviewPlatform } from '../code-review/enums';
import type { Owner, RepositoryIdentity } from '../code-review/repository-identity';
import {
  ReviewCapabilitiesSchema,
  ReviewActionSchema,
  type ReviewAction,
  type ReviewCapability,
  type ReviewIdentity,
} from './contracts';

// Test inputs only. Adapters must obtain capabilities from the actual authorized provider.
const repositories = {
  github: {
    provider: 'github',
    instanceUrl: 'https://github.com',
    repositoryId: 'R_repo',
    fullName: 'Team/Repo',
    defaultBranch: null,
  },
  gitlab: {
    provider: 'gitlab',
    instanceUrl: 'https://git.example/GitLab',
    repositoryId: 'project:42',
    fullName: 'Group/Sub/Repo',
    defaultBranch: 'trunk',
  },
  bitbucket: {
    provider: 'bitbucket',
    instanceUrl: 'https://bitbucket.org',
    repositoryId: '{22222222-2222-4222-8222-222222222222}',
    workspaceUuid: '{11111111-1111-4111-8111-111111111111}',
    fullName: 'Workspace/Repo',
    defaultBranch: null,
  },
} satisfies Record<CodeReviewPlatform, RepositoryIdentity>;
function reference(provider: CodeReviewPlatform, type: Owner['type']): ReviewIdentity {
  const repository = repositories[provider];
  const review = {
    reviewId: 'review:7',
    number: '7',
    canonicalUrl: `${repository.instanceUrl}/${repository.fullName}/${provider === 'gitlab' ? '-/merge_requests' : provider === 'github' ? 'pull' : 'pull-requests'}/7`,
  };
  if (repository.provider === 'github') {
    return {
      ...review,
      repository,
      authorization: { kind: 'githubUser', accountId: 'account', authorizationId: 'user-auth' },
    };
  }
  return {
    ...review,
    repository,
    authorization: {
      kind: 'ownerIntegration',
      owner: { type, id: 'owner' },
      integrationId: 'integration',
    },
  };
}
export const providerReviewFixtures = {
  github: { user: reference('github', 'user'), org: reference('github', 'org') },
  gitlab: { user: reference('gitlab', 'user'), org: reference('gitlab', 'org') },
  bitbucket: { user: null, org: reference('bitbucket', 'org') },
} satisfies Record<CodeReviewPlatform, Record<Owner['type'], ReviewIdentity | null>>;

const supported = {
  read: 'supported',
  comment: 'supported',
  inlineComment: 'supported',
  reply: 'supported',
  submitReview: 'supported',
  approve: 'supported',
  unapprove: 'supported',
  requestChanges: 'supported',
  removeChangeRequest: 'supported',
  resolveThread: 'supported',
  reopenThread: 'supported',
  addReaction: 'supported',
  removeReaction: 'supported',
  merge: 'supported',
  deleteBranch: 'supported',
  updateBranch: 'supported',
  enableAutoMerge: 'supported',
  disableAutoMerge: 'supported',
} satisfies Record<ReviewAction, ReviewCapability['support']>;
const support = {
  github: { ...supported, unapprove: 'unknown', removeChangeRequest: 'unknown' },
  gitlab: supported,
  bitbucket: {
    ...supported,
    addReaction: 'unsupported',
    removeReaction: 'unsupported',
    updateBranch: 'unsupported',
    enableAutoMerge: 'unsupported',
    disableAutoMerge: 'unsupported',
  },
} satisfies Record<CodeReviewPlatform, Record<ReviewAction, ReviewCapability['support']>>;
export const availableCapabilityFixture: ReviewCapability = {
  support: 'supported',
  version: 'available',
  license: 'available',
  permission: 'allowed',
  restrictions: [],
  explanation: '',
  evidenceUrl: null,
  recovery: 'none',
  expectedHeadProtection: 'none',
};
const bitbucketEvidence: Partial<Record<ReviewAction, string>> = {
  addReaction: 'https://jira.atlassian.com/browse/BCLOUD-21346',
  removeReaction: 'https://jira.atlassian.com/browse/BCLOUD-21346',
  updateBranch: 'https://jira.atlassian.com/browse/BCLOUD-20489',
  enableAutoMerge: 'https://jira.atlassian.com/browse/BCLOUD-22062',
  disableAutoMerge: 'https://jira.atlassian.com/browse/BCLOUD-22062',
};
export function reviewCapabilityFixtures(provider: CodeReviewPlatform) {
  return ReviewCapabilitiesSchema.parse(
    Object.fromEntries(
      ReviewActionSchema.options.map(action => [
        action,
        {
          ...availableCapabilityFixture,
          support: support[provider][action],
          explanation:
            support[provider][action] === 'unsupported'
              ? 'The public provider API does not expose this action.'
              : '',
          evidenceUrl: provider === 'bitbucket' ? (bitbucketEvidence[action] ?? null) : null,
          expectedHeadProtection:
            provider !== 'bitbucket' &&
            (action === 'merge' || (provider === 'gitlab' && action === 'approve'))
              ? 'atomicSource'
              : provider !== 'bitbucket' && action === 'inlineComment'
                ? 'revisionAttachment'
                : 'none',
        },
      ])
    )
  );
}
