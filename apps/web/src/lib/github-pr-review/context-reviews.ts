import 'server-only';

import { z } from 'zod';
import { GitHubPrReviewTimestampSchema, type GitHubPrReviewContext } from './context-dtos';
import { contextIdentitySchema } from './context-people';

type Reviews = GitHubPrReviewContext['reviewDecisions'];
type Review = Reviews['items'][number];

function reviewQuery(field: 'latestOpinionatedReviews' | 'latestReviews') {
  return /* GraphQL */ `
    query PrReviewContext_${field}($owner: String!, $name: String!, $number: Int!, $after: String) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          ${field}(first: 100, after: $after${field === 'latestOpinionatedReviews' ? ', writersOnly: false' : ''}) {
            totalCount
            pageInfo { hasNextPage endCursor }
            nodes {
              id state submittedAt
              commit { oid }
              author {
                __typename
                ... on User { id login name avatarUrl url }
                ... on Bot { id login avatarUrl url }
                ... on Mannequin { id login avatarUrl url }
              }
              onBehalfOf(first: 100) {
                totalCount
                pageInfo { hasNextPage endCursor }
                nodes { __typename id teamName: name slug teamAvatarUrl: avatarUrl url }
              }
            }
          }
        }
      }
    }
  `;
}

export const PR_CONTEXT_REVIEW_QUERIES = {
  latestOpinionatedReviews: reviewQuery('latestOpinionatedReviews'),
  latestReviews: reviewQuery('latestReviews'),
};

const attributionSchema = z
  .object({
    nodes: z.array(contextIdentitySchema.nullable().catch(null)).nullish().catch(null),
    totalCount: z.number().int().nonnegative().nullish().catch(null),
    pageInfo: z
      .object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() })
      .nullish()
      .catch(null),
  })
  .nullable()
  .catch(null);

export const contextReviewSchema = z
  .object({
    id: z.string().min(1),
    author: contextIdentitySchema
      .refine(actor => actor.kind !== 'Team')
      .nullable()
      .catch(null),
    state: z
      .enum(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED', 'PENDING', 'UNKNOWN'])
      .catch('UNKNOWN'),
    submittedAt: GitHubPrReviewTimestampSchema.nullable().catch(null),
    commit: z
      .object({ oid: z.string().min(1) })
      .nullable()
      .catch(null),
    onBehalfOf: attributionSchema,
  })
  .transform((review): Review => {
    const teams = review.onBehalfOf;
    const items = [
      ...new Map(
        (teams?.nodes ?? []).flatMap(team =>
          team?.id && team.kind === 'Team' ? [[team.id, team] as const] : []
        )
      ).values(),
    ];
    const complete =
      teams?.nodes != null &&
      teams.pageInfo?.hasNextPage === false &&
      items.length === teams.nodes.length &&
      items.length === teams.totalCount;
    return {
      id: review.id,
      actor: review.author,
      state: review.state,
      submittedAt: review.state === 'PENDING' ? null : review.submittedAt,
      commitSha: review.commit?.oid ?? null,
      // Attribution is not team approval. An unfinished nested page never proves full attribution.
      onBehalfOf: {
        items,
        knownCount: items.length,
        totalCount: teams?.totalCount ?? null,
        hasNextPage: teams?.pageInfo?.hasNextPage ?? null,
        endCursor: teams?.pageInfo?.endCursor ?? null,
        completeness: complete ? 'complete' : items.length ? 'partial' : 'unknown',
        source: {
          availability: complete ? 'available' : items.length ? 'partial' : 'unavailable',
          retryable: !complete,
          reason: complete ? null : 'attribution-incomplete',
          provenance: ['graphql.review.onBehalfOf'],
          observedAt: new Date().toISOString(),
        },
      },
    };
  });
