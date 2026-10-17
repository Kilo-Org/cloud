import * as z from 'zod';
import {
  CustomRouterScopeSchema,
  customRouterEntryKey,
  customRouterModelId,
  type GatewayCustomRouterEntry,
} from './custom-router';
import { AutoRoutingModeSchema, type AutoRouter, type AutoRoutingMode } from './router';
import { MAX_POOL_ENTRIES } from './routing-table';

// ADR 0005 cutover: each saved owner pool for efficient becomes this custom router.
export const OWNER_POOL_CONVERSION_PATH = '/api/internal/auto-routing/owner-pool-conversions';
export const CONVERTED_ROUTER_SLUG = 'efficient';
export const CONVERTED_ROUTER_NAME = 'Efficient';
export const CONVERTED_ROUTER_BASE: AutoRouter = 'efficient';
// Conversions run one by one and send their notices inline, so a batch stays well inside the
// web route's duration limit.
export const MAX_OWNER_POOL_CONVERSIONS_PER_REQUEST = 25;

export const OwnerPoolConversionOwnerSchema = z.object({
  type: CustomRouterScopeSchema,
  id: z.string().trim().min(1),
});
export type OwnerPoolConversionOwner = z.infer<typeof OwnerPoolConversionOwnerSchema>;

export const OwnerPoolConversionSchema = z.object({
  owner: OwnerPoolConversionOwnerSchema,
  mode: AutoRoutingModeSchema,
  // Pool order is kept: the first model becomes the default member.
  models: z
    .array(z.string().trim().min(1))
    .min(1)
    .max(MAX_POOL_ENTRIES)
    .refine(models => new Set(models).size === models.length, 'Models must be unique'),
});
export type OwnerPoolConversion = z.infer<typeof OwnerPoolConversionSchema>;

export const OwnerPoolConversionRequestSchema = z.object({
  conversions: z
    .array(OwnerPoolConversionSchema)
    .min(1)
    .max(MAX_OWNER_POOL_CONVERSIONS_PER_REQUEST),
});
export type OwnerPoolConversionRequest = z.infer<typeof OwnerPoolConversionRequestSchema>;

export const OwnerPoolConversionOutcomeSchema = z.enum([
  'created',
  // The owner's `efficient` router already holds this pool, default member, mode, and base.
  'exists',
  // The owner has its own `efficient` router that differs; the pool was not converted.
  'slug_taken',
  'router_cap_reached',
  'owner_not_found',
  'failed',
]);
export type OwnerPoolConversionOutcome = z.infer<typeof OwnerPoolConversionOutcomeSchema>;

export const OwnerPoolConversionResultSchema = z.object({
  owner: OwnerPoolConversionOwnerSchema,
  outcome: OwnerPoolConversionOutcomeSchema,
  modelId: z.string(),
  noticesSent: z.number().int().nonnegative(),
  noticesFailed: z.number().int().nonnegative(),
});
export type OwnerPoolConversionResult = z.infer<typeof OwnerPoolConversionResultSchema>;

export const OwnerPoolConversionResponseSchema = z.object({
  results: z.array(OwnerPoolConversionResultSchema),
});
export type OwnerPoolConversionResponse = z.infer<typeof OwnerPoolConversionResponseSchema>;

// The auto-routing worker's one-off scan route; the operator script drives it.
export const OWNER_POOL_CONVERSION_SCAN_PATH = '/admin/owner-pool-conversion/scan';
// `exists` is listed because an unmarked owner whose router already matches was most likely
// converted by an interrupted run; whether its notice went out is unknown, so the operator checks
// Mailgun or Sentry before sending anything.
export const OWNER_POOL_CONVERSION_ATTENTION_OUTCOMES = [
  'exists',
  'owner_not_found',
  'slug_taken',
  'router_cap_reached',
  'failed',
] as const satisfies readonly OwnerPoolConversionOutcome[];

export const OwnerPoolConversionScanResponseSchema = z.object({
  scanned: z.number().int().nonnegative(),
  nextCursor: z.string().nullable(),
  matchedObjectIds: z.array(z.string()),
  // Owners an earlier run already converted; they are skipped.
  alreadyConverted: z.number().int().nonnegative(),
  conversions: z.number().int().nonnegative(),
  droppedModeOnly: z.number().int().nonnegative(),
  // `<ownerType>:<ownerId>` keys.
  readFailed: z.array(z.string()),
  invalidPool: z.array(z.string()),
  // Converted with the default mode because the stored mode was invalid.
  invalidMode: z.array(z.string()),
  // `<reason> <ownerType>:<ownerId>`: every OWNER_POOL_CONVERSION_ATTENTION_OUTCOMES result,
  // `notice_failed` when an owner got no notice, and `mark_failed` when the marker could not be
  // stored.
  needsAttention: z.array(z.string()),
  outcomes: z.record(OwnerPoolConversionOutcomeSchema, z.number().int().nonnegative()),
  noticesSent: z.number().int().nonnegative(),
  noticesFailed: z.number().int().nonnegative(),
  // The page stopped posting because the web endpoint looks unavailable.
  aborted: z.boolean(),
  // Fields below are defaulted so a newer script still reads a worker deployed before them.
  // `<ownerType>:<ownerId>` keys the endpoint never received: not failures, and retried as is.
  notPosted: z.array(z.string()).default([]),
  // `batch_failed`: a batch request failed or timed out. `consecutive_failures`: too many owners
  // that had not failed before failed in a row.
  abortReason: z.enum(['batch_failed', 'consecutive_failures']).nullable().default(null),
  // New `failed` results in a row at the end of this page; the next page request carries it on.
  consecutiveFailed: z.number().int().nonnegative().default(0),
});
export type OwnerPoolConversionScanResponse = z.infer<typeof OwnerPoolConversionScanResponseSchema>;

export type ConvertedOwnerPoolRouter = {
  slug: string;
  name: string;
  baseRouter: AutoRouter;
  mode: AutoRoutingMode;
  entries: GatewayCustomRouterEntry[];
  defaultEntryKey: string;
  modelId: string;
};

export function convertedOwnerPoolRouter(
  conversion: OwnerPoolConversion
): ConvertedOwnerPoolRouter {
  const entries = conversion.models.map(
    (model): GatewayCustomRouterEntry => ({ kind: 'gateway', model })
  );
  const [first] = entries;
  if (!first) throw new Error('An owner pool conversion needs at least one model');
  return {
    slug: CONVERTED_ROUTER_SLUG,
    name: CONVERTED_ROUTER_NAME,
    baseRouter: CONVERTED_ROUTER_BASE,
    mode: conversion.mode,
    entries,
    defaultEntryKey: customRouterEntryKey(first),
    modelId: customRouterModelId(conversion.owner.type, CONVERTED_ROUTER_SLUG),
  };
}
