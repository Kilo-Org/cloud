import * as z from 'zod';
import {
  CustomRouterScopeSchema,
  customRouterEntryKey,
  customRouterModelId,
  type GatewayCustomRouterEntry,
} from './custom-router';
import { AutoRoutingModeSchema, type AutoRouter, type AutoRoutingMode } from './router';
import { MAX_POOL_ENTRIES } from './routing-table';

export const OWNER_POOL_CONVERSION_PATH = '/api/internal/auto-routing/owner-pool-conversions';
export const CONVERTED_ROUTER_SLUG = 'efficient';
export const CONVERTED_ROUTER_NAME = 'Efficient';
export const CONVERTED_ROUTER_BASE: AutoRouter = 'efficient';
export const MAX_OWNER_POOL_CONVERSIONS_PER_REQUEST = 5;

export const OwnerPoolConversionOwnerSchema = z.object({
  type: CustomRouterScopeSchema,
  id: z.string().trim().min(1),
});
export type OwnerPoolConversionOwner = z.infer<typeof OwnerPoolConversionOwnerSchema>;

export const OwnerPoolConversionSchema = z.object({
  owner: OwnerPoolConversionOwnerSchema,
  mode: AutoRoutingModeSchema,
  configuredMode: AutoRoutingModeSchema.nullable().optional(),
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
  'exists',
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

export const OWNER_POOL_CONVERSION_SCAN_PATH = '/admin/owner-pool-conversion/scan';
export const OWNER_POOL_CONVERSION_ATTENTION_OUTCOMES = [
  'owner_not_found',
  'slug_taken',
  'router_cap_reached',
  'failed',
] as const satisfies readonly OwnerPoolConversionOutcome[];

export const OwnerPoolConversionScanResponseSchema = z.object({
  scanned: z.number().int().nonnegative(),
  nextCursor: z.string().nullable(),
  matchedObjectIds: z.array(z.string()),
  alreadyConverted: z.number().int().nonnegative(),
  conversions: z.number().int().nonnegative(),
  droppedModeOnly: z.number().int().nonnegative(),
  readFailed: z.array(z.string()),
  invalidPool: z.array(z.string()),
  invalidMode: z.array(z.string()),
  needsAttention: z.array(z.string()),
  outcomes: z.record(OwnerPoolConversionOutcomeSchema, z.number().int().nonnegative()),
  noticesSent: z.number().int().nonnegative(),
  noticesFailed: z.number().int().nonnegative(),
  aborted: z.boolean(),
  notPosted: z.array(z.string()).default([]),
  abortReason: z.enum(['batch_failed', 'consecutive_failures']).nullable().catch(null),
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
  legacyModeInherited: boolean;
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
    legacyModeInherited: conversion.configuredMode === null,
    entries,
    defaultEntryKey: customRouterEntryKey(first),
    modelId: customRouterModelId(conversion.owner.type, CONVERTED_ROUTER_SLUG),
  };
}
