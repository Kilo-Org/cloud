import 'server-only';

import { z } from 'zod';
import type { GitHubPrReviewIdentity } from './context-dtos';

function peopleQuery(field: 'labels' | 'assignees' | 'reviewRequests', selection: string) {
  return /* GraphQL */ `
    query PrReviewContext_${field}($owner: String!, $name: String!, $number: Int!, $after: String) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          ${field}(first: 100, after: $after) {
            totalCount
            pageInfo { hasNextPage endCursor }
            nodes { ${selection} }
          }
        }
      }
    }
  `;
}

export const PR_CONTEXT_PEOPLE_QUERIES = {
  labels: peopleQuery('labels', 'id name color'),
  assignees: peopleQuery('assignees', '__typename id login name avatarUrl url'),
  reviewRequests: peopleQuery(
    'reviewRequests',
    `
    id
    requestedReviewer {
      __typename
      ... on User { id login name avatarUrl url }
      ... on Team { id teamName: name slug teamAvatarUrl: avatarUrl url }
      ... on Bot { id login avatarUrl url }
      ... on Mannequin { id login avatarUrl url }
    }
  `
  ),
};

export const contextLabelSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  color: z
    .string()
    .nullish()
    .transform(value => value ?? null),
});
const identityFields = z.object({
  id: z.string().min(1),
  avatarUrl: z.string().url().nullable().catch(null),
  url: z.string().url().nullable().catch(null),
});
export const contextIdentitySchema = z
  .union([
    identityFields.extend({
      __typename: z.literal('User'),
      login: z.string(),
      name: z.string().nullable(),
    }),
    identityFields.extend({ __typename: z.enum(['Bot', 'Mannequin']), login: z.string() }),
    // Team field nullability differs from User, so the query uses distinct aliases.
    identityFields.extend({
      __typename: z.literal('Team'),
      teamName: z.string(),
      slug: z.string(),
      teamAvatarUrl: identityFields.shape.avatarUrl,
    }),
  ])
  .transform(
    (actor): GitHubPrReviewIdentity => ({
      id: actor.id,
      kind: actor.__typename,
      login: 'login' in actor ? actor.login : null,
      name:
        actor.__typename === 'Team'
          ? actor.teamName.trim() || null
          : 'name' in actor
            ? actor.name?.trim() || null
            : null,
      avatarUrl: actor.__typename === 'Team' ? actor.teamAvatarUrl : actor.avatarUrl,
      url: actor.url,
      teamSlug: 'slug' in actor ? actor.slug : null,
    })
  );
const unavailableIdentity: GitHubPrReviewIdentity = {
  id: null,
  kind: 'Unavailable',
  login: null,
  name: null,
  avatarUrl: null,
  url: null,
  teamSlug: null,
};
export const contextReviewRequestSchema = z
  .object({
    id: z.string().min(1),
    requestedReviewer: contextIdentitySchema.nullable().catch(null),
  })
  .transform(request => ({
    id: request.id,
    reviewer: request.requestedReviewer ?? unavailableIdentity,
  }));

export function mergeKnownContextIdentity(
  known: GitHubPrReviewIdentity | null,
  current: GitHubPrReviewIdentity | null
): GitHubPrReviewIdentity | null {
  if (!current || current.kind === 'Unavailable') return known ?? current;
  if (!known || known.id !== current.id || known.kind !== current.kind) return current;
  return {
    ...current,
    login: current.login ?? known.login,
    name: current.name ?? known.name,
    avatarUrl: current.avatarUrl ?? known.avatarUrl,
    url: current.url ?? known.url,
    teamSlug: current.teamSlug ?? known.teamSlug,
  };
}
