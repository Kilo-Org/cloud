import { z } from 'zod';
import { prIntentFingerprint } from '../pr-review/intent-fingerprint';
import {
  ProviderReferenceSchema,
  ReviewActionSchema,
  ReviewPositionSchema,
  ReviewRevisionSchema,
  reviewResourceKey,
  type ReviewIdentity,
  type ReviewRevision,
} from './contracts';

// Old GitHub clients and ledger rows use these exact bytes and optional-field ordering.
// Remove this path only after old clients/records disappear and the 30-day ledger window expires.
export const legacyGitHubIntentFingerprint = prIntentFingerprint;

const id = z.string().min(1);
export const ReviewIntentInputSchema = z.strictObject({
  action: ReviewActionSchema.exclude(['read']),
  body: z.string().optional(),
  target: ProviderReferenceSchema.optional(),
  position: ReviewPositionSchema.optional(),
  choice: z.enum(['comment', 'approve', 'requestChanges']).optional(),
  comments: z
    .array(z.strictObject({ itemId: id, body: z.string(), position: ReviewPositionSchema }))
    .optional(),
  draftReferences: z.array(ProviderReferenceSchema).optional(),
  reaction: id.optional(),
  method: id.optional(),
  squash: z.boolean().optional(),
  commitTitle: z.string().optional(),
  commitMessage: z.string().optional(),
  deletion: z
    .strictObject({
      effect: z.enum(['keep', 'delete']),
      repositoryKey: id,
      branch: id,
      expectedHeadSha: id,
    })
    .optional(),
});
export type ReviewIntentInput = z.infer<typeof ReviewIntentInputSchema>;
export type ReviewIntent = {
  accountId: string;
  review: ReviewIdentity;
  actorId: string;
  revision: ReviewRevision;
  input: ReviewIntentInput;
};

export function providerReviewIntentFingerprint(intent: ReviewIntent): string {
  // Parsing fixes field order recursively and rejects unrecognized intent fields instead of dropping them.
  return JSON.stringify([
    'provider-review-intent:v1',
    reviewResourceKey(intent.accountId, intent.review),
    id.parse(intent.actorId),
    ReviewRevisionSchema.parse(intent.revision),
    ReviewIntentInputSchema.parse(intent.input),
  ]);
}
