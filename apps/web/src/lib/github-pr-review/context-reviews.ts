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

const reviewerKey = (review: Review) =>
  review.actor?.id ? `${review.actor.kind}:${review.actor.id}` : `review:${review.id}`;
const isDecision = (review: Review) =>
  ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state);

export function contextReviewsAgree(first: Review, second: Review) {
  return (
    first.id === second.id &&
    first.state === second.state &&
    reviewerKey(first) === reviewerKey(second) &&
    !(first.commitSha && second.commitSha && first.commitSha !== second.commitSha) &&
    !(
      first.submittedAt &&
      second.submittedAt &&
      Date.parse(first.submittedAt) !== Date.parse(second.submittedAt)
    )
  );
}

export function resolveContextReviewDecisions(opinionated: Reviews, activity: Reviews): Reviews {
  const groups = new Map<string, { opinionated: Review[]; activity: Review[] }>();
  const reviewsById = new Map<string, Review>();
  const conflicts = new Set<string>();
  for (const [field, reviews] of [
    ['opinionated', opinionated],
    ['activity', activity],
  ] as const) {
    for (const review of reviews.items) {
      const previous = reviewsById.get(review.id);
      if (previous && !contextReviewsAgree(previous, review)) conflicts.add(review.id);
      reviewsById.set(review.id, review);
      const key = reviewerKey(review);
      const group = groups.get(key) ?? { opinionated: [], activity: [] };
      group[field].push(review);
      groups.set(key, group);
    }
  }
  const incomplete = [opinionated, activity].find(reviews => reviews.completeness !== 'complete');
  let inconsistent = false;
  const items: Review[] = [];
  for (const group of groups.values()) {
    const decision = group.opinionated[0];
    const latest = group.activity[0];
    const selected = decision ?? latest;
    if (!selected) continue;
    const sameReview = decision && latest && contextReviewsAgree(decision, latest);
    const laterComment =
      decision &&
      latest?.state === 'COMMENTED' &&
      decision.id !== latest.id &&
      !(
        decision.submittedAt &&
        latest.submittedAt &&
        Date.parse(latest.submittedAt) < Date.parse(decision.submittedAt)
      );
    // A review ID must agree across reviewer groups too, even beside a different later comment.
    const conflicted = [...group.opinionated, ...group.activity].some(review =>
      conflicts.has(review.id)
    );
    // Do not rank conflicting decisions by a clock or resurrect an approval after dismissal.
    const supported =
      !conflicted &&
      group.opinionated.length <= 1 &&
      group.activity.length <= 1 &&
      (decision
        ? isDecision(decision) && (sameReview || laterComment)
        : !incomplete && latest && isDecision(latest));
    if (supported) items.push(selected);
    else if (
      conflicted ||
      group.opinionated.some(isDecision) ||
      group.activity.some(isDecision) ||
      group.opinionated.length > 1 ||
      group.activity.length > 1 ||
      selected.state === 'UNKNOWN' ||
      latest?.state === 'UNKNOWN' ||
      selected.state === 'PENDING' ||
      latest?.state === 'PENDING' ||
      (decision && !latest)
    ) {
      inconsistent ||=
        conflicted ||
        !incomplete ||
        Boolean(decision && latest && decision.state !== 'UNKNOWN' && latest.state !== 'UNKNOWN');
      items.push({ ...selected, state: 'UNKNOWN' });
    }
  }
  const complete = !incomplete && !inconsistent;
  return {
    items,
    knownCount: items.length,
    totalCount: complete ? items.length : null,
    hasNextPage: opinionated.hasNextPage || activity.hasNextPage ? true : complete ? false : null,
    // The two connections have independent cursors; this derived collection has no single cursor.
    endCursor: null,
    completeness: complete ? 'complete' : items.length ? 'partial' : 'unknown',
    source: {
      ...(incomplete?.source ?? opinionated.source),
      availability: complete
        ? 'available'
        : items.length || inconsistent
          ? 'partial'
          : (incomplete?.source.availability ?? 'unavailable'),
      reason: inconsistent ? 'review-inconsistent' : (incomplete?.source.reason ?? null),
      retryable: inconsistent || opinionated.source.retryable || activity.source.retryable,
      provenance: [...new Set([...opinionated.source.provenance, ...activity.source.provenance])],
    },
  };
}
