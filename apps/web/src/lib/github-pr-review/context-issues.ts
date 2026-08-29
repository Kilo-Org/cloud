import 'server-only';

import { z } from 'zod';
import { GitHubPrReviewIssueSchema, GitHubPrReviewTimestampSchema } from './context-dtos';

const endpointFragment = /* GraphQL */ `
  fragment ContextIssueEndpoint on Node {
    id __typename
    ... on Issue { number title state url repository { nameWithOwner } }
  }
`;
export const PR_CONTEXT_ISSUE_QUERIES = {
  closingIssuesReferences: /* GraphQL */ `
    query PrReviewContextClosingIssues($owner: String!, $name: String!, $number: Int!, $after: String) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          id
          closingIssuesReferences(first: 100, after: $after, userLinkedOnly: false) {
            totalCount
            pageInfo { hasNextPage endCursor }
            nodes { ...ContextIssueEndpoint }
          }
        }
      }
    }
    ${endpointFragment}
  `,
  timelineItems: /* GraphQL */ `
    query PrReviewContextIssueEvents($owner: String!, $name: String!, $number: Int!, $after: String) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          id
          timelineItems(first: 100, after: $after, itemTypes: [CONNECTED_EVENT, DISCONNECTED_EVENT, CROSS_REFERENCED_EVENT, MARKED_AS_DUPLICATE_EVENT, UNMARKED_AS_DUPLICATE_EVENT]) {
            totalCount
            pageInfo { hasNextPage endCursor }
            nodes {
              __typename
              ... on ConnectedEvent { id createdAt source { ...ContextIssueEndpoint } subject { ...ContextIssueEndpoint } }
              ... on DisconnectedEvent { id createdAt source { ...ContextIssueEndpoint } subject { ...ContextIssueEndpoint } }
              ... on CrossReferencedEvent { id createdAt referencedAt source { ...ContextIssueEndpoint } target { ...ContextIssueEndpoint } willCloseTarget }
              ... on MarkedAsDuplicateEvent { id createdAt canonical { ...ContextIssueEndpoint } duplicate { ...ContextIssueEndpoint } }
              ... on UnmarkedAsDuplicateEvent { id createdAt canonical { ...ContextIssueEndpoint } duplicate { ...ContextIssueEndpoint } }
            }
          }
        }
      }
    }
    ${endpointFragment}
  `,
};

export const contextIssueSchema = GitHubPrReviewIssueSchema.omit({
  relationships: true,
  repository: true,
}).extend({
  __typename: z.literal('Issue'),
  repository: z.object({ nameWithOwner: z.string().min(1) }),
  url: GitHubPrReviewIssueSchema.shape.url.catch(null),
});
const endpointSchema = z
  .discriminatedUnion('__typename', [
    contextIssueSchema,
    z.object({ __typename: z.literal('PullRequest'), id: z.string().min(1) }),
  ])
  .nullable();
const eventFields = {
  id: z.string().min(1),
  createdAt: GitHubPrReviewTimestampSchema.nullable().catch(null),
};
export const contextIssueEventSchema = z
  .union([
    z.object({
      ...eventFields,
      __typename: z.enum(['ConnectedEvent', 'DisconnectedEvent']),
      source: endpointSchema,
      subject: endpointSchema,
    }),
    z.object({
      ...eventFields,
      __typename: z.literal('CrossReferencedEvent'),
      source: endpointSchema,
      target: endpointSchema,
    }),
    z.object({
      ...eventFields,
      __typename: z.enum(['MarkedAsDuplicateEvent', 'UnmarkedAsDuplicateEvent']),
      canonical: endpointSchema,
      duplicate: endpointSchema,
    }),
  ])
  .transform(event => ({
    id: event.id,
    createdAt: event.createdAt,
    category:
      'canonical' in event
        ? ('duplicate' as const)
        : 'subject' in event
          ? ('connected' as const)
          : ('referenced' as const),
    removed: ['DisconnectedEvent', 'UnmarkedAsDuplicateEvent'].includes(event.__typename),
    source: 'duplicate' in event ? event.duplicate : event.source,
    target:
      'canonical' in event ? event.canonical : 'subject' in event ? event.subject : event.target,
  }));
