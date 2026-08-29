import 'server-only';

import { z } from 'zod';
import {
  GitHubPrReviewIssueSchema,
  GitHubPrReviewTimestampSchema,
  type GitHubPrReviewContext,
} from './context-dtos';

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

type Issue = GitHubPrReviewContext['issues']['items'][number];
type Collection<T> = Omit<GitHubPrReviewContext['issues'], 'items'> & { items: T[] };

export function resolveContextIssues(
  prId: string,
  closing: Collection<z.output<typeof contextIssueSchema>>,
  history: Collection<z.output<typeof contextIssueEventSchema>>
): GitHubPrReviewContext['issues'] {
  const ordered = history.items.every(
    (event, index) =>
      event.createdAt !== null &&
      (index === 0 ||
        Date.parse(event.createdAt) >= Date.parse(history.items[index - 1]?.createdAt ?? ''))
  );
  const historyComplete =
    history.completeness === 'complete' &&
    ordered &&
    history.items.every(event => event.source !== null && event.target !== null);
  const relationships = new Map<
    string,
    {
      issue: z.output<typeof contextIssueSchema>;
      relationship: Issue['relationships'][number];
    }
  >();
  for (const issue of closing.items) {
    relationships.set(`closing:${issue.id}`, {
      issue,
      relationship: {
        category: 'closing',
        membership: 'current',
        evidenceId: issue.id,
        sourceId: prId,
        targetId: issue.id,
      },
    });
  }
  for (const event of history.items) {
    const { source, target, category } = event;
    if (!source || !target) continue;
    const issue =
      source.id === prId && source.__typename === 'PullRequest'
        ? target
        : target.id === prId && target.__typename === 'PullRequest'
          ? source
          : null;
    if (issue?.__typename !== 'Issue') continue;
    const current = historyComplete && category !== 'referenced';
    const key = current ? JSON.stringify([category, source.id, target.id]) : event.id;
    if (current && event.removed) relationships.delete(key);
    else
      relationships.set(key, {
        issue,
        relationship: {
          category,
          membership: current ? 'current' : 'historical',
          evidenceId: event.id,
          sourceId: source.id,
          targetId: target.id,
        },
      });
  }
  const issues = new Map<string, Issue>();
  for (const { issue, relationship } of relationships.values()) {
    const known: Issue = issues.get(issue.id) ?? {
      id: issue.id,
      number: issue.number,
      title: issue.title,
      state: issue.state,
      url: issue.url,
      repository: issue.repository.nameWithOwner,
      relationships: [],
    };
    known.url ??= issue.url;
    known.relationships.push(relationship);
    issues.set(issue.id, known);
  }
  const sources = [closing.source, history.source];
  const failure = sources.find(source => source.availability !== 'available');
  const complete = closing.completeness === 'complete' && historyComplete;
  // Counts cover supported PR-side sources, not every outgoing or inaccessible relationship.
  return {
    items: [...issues.values()],
    knownCount: issues.size,
    totalCount: complete ? issues.size : null,
    completeness: complete ? 'complete' : issues.size ? 'partial' : 'unknown',
    hasNextPage: [closing, history].some(source => source.hasNextPage === true)
      ? true
      : [closing, history].every(source => source.hasNextPage === false)
        ? false
        : null,
    endCursor: null,
    source: {
      ...closing.source,
      observedAt: history.source.observedAt ?? closing.source.observedAt,
      provenance: sources.flatMap(source => source.provenance),
      availability: complete
        ? 'available'
        : issues.size
          ? 'partial'
          : failure?.availability === 'denied'
            ? 'denied'
            : 'unavailable',
      retryable:
        sources.some(source => source.retryable) ||
        (!ordered && history.source.availability === 'available'),
      reason: complete ? null : (failure?.reason ?? 'issue-history-incomplete'),
    },
  };
}
