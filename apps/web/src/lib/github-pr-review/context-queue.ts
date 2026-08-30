import 'server-only';

import { z } from 'zod';
import { GitHubPrReviewQueueSchema, GitHubPrReviewTimestampSchema } from './context-dtos';

export const PR_CONTEXT_QUEUE_QUERIES = {
  queueMembership: /* GraphQL */ `
    query PrReviewContextQueueMembership($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) { id membership: mergeQueueEntry { id } }
      }
    }
  `,
  queueEntry: /* GraphQL */ `
    query PrReviewContextQueueEntry($entryId: ID!) {
      node(id: $entryId) {
        __typename
        ... on MergeQueueEntry { id position state enqueuedAt pullRequest { id } }
      }
    }
  `,
};

export const contextQueueEntrySchema = z.object({
  __typename: z.literal('MergeQueueEntry'),
  id: z.string().min(1),
  pullRequest: z.object({ id: z.string().min(1) }),
  position: z.number().int().nonnegative(),
  state: GitHubPrReviewQueueSchema.shape.position.shape.state.unwrap(),
  enqueuedAt: GitHubPrReviewTimestampSchema,
});
