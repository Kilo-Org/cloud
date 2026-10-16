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
  conversions: z.array(OwnerPoolConversionSchema).min(1).max(MAX_OWNER_POOL_CONVERSIONS_PER_REQUEST),
});
export type OwnerPoolConversionRequest = z.infer<typeof OwnerPoolConversionRequestSchema>;

export const OwnerPoolConversionOutcomeSchema = z.enum([
  'created',
  // The owner already has a router with the converted slug; re-runs land here.
  'exists',
  'router_cap_reached',
  'owner_not_found',
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

export type ConvertedOwnerPoolRouter = {
  slug: string;
  name: string;
  baseRouter: AutoRouter;
  mode: AutoRoutingMode;
  entries: GatewayCustomRouterEntry[];
  defaultEntryKey: string;
  modelId: string;
};

export function convertedOwnerPoolRouter(conversion: OwnerPoolConversion): ConvertedOwnerPoolRouter {
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
