import * as z from 'zod';
import { AutoRouterSchema } from './router';

/** Worker admin path behind the internal admin secret. */
export const BENCHMARK_ALIAS_PROMOTION_PATH = '/admin/alias-promotion';

/** Short global fence: a holder reads the affected ready pairs and saves observed pins together. */
export const ALIAS_PROMOTION_LEASE_MS = 60_000;

/** Concrete model ids one acquire may ask about: an alias's previous targets, deduped by pool. */
export const MAX_ALIAS_PROMOTION_MODELS = 32;

const AliasPromotionModelSchema = z.string().trim().min(1);

export const AliasPromotionRequestSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('acquire'),
    token: z.uuid(),
    models: z.array(AliasPromotionModelSchema).max(MAX_ALIAS_PROMOTION_MODELS),
  }),
  z.object({ action: z.literal('release'), token: z.uuid() }),
]);
export type AliasPromotionRequest = z.infer<typeof AliasPromotionRequestSchema>;

export const AliasPromotionReadyPairSchema = z.object({
  router: AutoRouterSchema,
  model: AliasPromotionModelSchema,
});
export type AliasPromotionReadyPair = z.infer<typeof AliasPromotionReadyPairSchema>;

/**
 * `held` carries the fence's own expiry (database clock) and the ready, current-engine registry
 * pairs of the asked concrete ids. `busy` means another holder's fence is live.
 */
export const AliasPromotionAcquireResponseSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('held'),
    leaseUntil: z.number().int().positive(),
    ready: z.array(AliasPromotionReadyPairSchema),
  }),
  z.object({ status: z.literal('busy') }),
]);
export type AliasPromotionAcquireResponse = z.infer<typeof AliasPromotionAcquireResponseSchema>;

export const AliasPromotionReleaseResponseSchema = z.object({ status: z.literal('released') });
export type AliasPromotionReleaseResponse = z.infer<typeof AliasPromotionReleaseResponseSchema>;
