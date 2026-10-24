import 'server-only';

import {
  CustomRouterEntriesSchema,
  MAX_CUSTOM_ROUTERS_PER_OWNER,
  convertedOwnerPoolRouter,
  customRouterEntryKey,
  type ConvertedOwnerPoolRouter,
  type OwnerPoolConversion,
  type OwnerPoolConversionOutcome,
  type OwnerPoolConversionOwner,
  type OwnerPoolConversionRequest,
  type OwnerPoolConversionResponse,
  type OwnerPoolConversionResult,
} from '@kilocode/auto-routing-contracts';
import { auto_routing_custom_routers, kilocode_users, organizations } from '@kilocode/db/schema';
import { customRouterOwnerCondition } from '@kilocode/web-shared/lib/ai-gateway/custom-routers';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { warnExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import { captureException } from '@sentry/nextjs';
import { and, eq, isNull } from 'drizzle-orm';
import * as z from 'zod';
import { lockOwner, ownerRouterSlugs } from '@/lib/auto-routing-custom-routers';

async function ownerExists(owner: OwnerPoolConversionOwner): Promise<boolean> {
  if (owner.type === 'user') {
    const [user] = await db
      .select({ id: kilocode_users.id })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, owner.id))
      .limit(1);
    return Boolean(user);
  }
  if (!z.uuid().safeParse(owner.id).success) return false;
  const [organization] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(and(eq(organizations.id, owner.id), isNull(organizations.deleted_at)))
    .limit(1);
  return Boolean(organization);
}

async function insertConvertedRouter(
  owner: OwnerPoolConversionOwner,
  router: ConvertedOwnerPoolRouter
): Promise<OwnerPoolConversionOutcome> {
  return db.transaction(async tx => {
    await lockOwner(tx, owner);
    const [sameSlug] = await tx
      .select()
      .from(auto_routing_custom_routers)
      .where(
        and(customRouterOwnerCondition(owner), eq(auto_routing_custom_routers.slug, router.slug))
      )
      .limit(1);
    if (sameSlug) {
      if (sameSlug.legacy_pool) return 'exists';
      const existingKeys = new Set(sameSlug.entries.map(customRouterEntryKey));
      const holdsPool =
        sameSlug.mode === router.mode &&
        sameSlug.base_router === router.baseRouter &&
        sameSlug.default_entry_key === router.defaultEntryKey &&
        sameSlug.entries.length === router.entries.length &&
        existingKeys.size === router.entries.length &&
        router.entries.every(entry => existingKeys.has(customRouterEntryKey(entry)));
      if (!holdsPool) return 'slug_taken';
      await tx
        .update(auto_routing_custom_routers)
        .set({ legacy_pool: true, legacy_mode_inherited: router.legacyModeInherited })
        .where(eq(auto_routing_custom_routers.id, sameSlug.id));
      return 'exists';
    }
    const existing = await ownerRouterSlugs(tx, owner);
    if (existing.length >= MAX_CUSTOM_ROUTERS_PER_OWNER) return 'router_cap_reached';
    await tx.insert(auto_routing_custom_routers).values({
      owned_by_user_id: owner.type === 'user' ? owner.id : null,
      owned_by_organization_id: owner.type === 'org' ? owner.id : null,
      created_by_user_id: owner.type === 'user' ? owner.id : null,
      slug: router.slug,
      name: router.name,
      base_router: router.baseRouter,
      mode: router.mode,
      entries: router.entries,
      default_entry_key: router.defaultEntryKey,
      legacy_pool: true,
      legacy_mode_inherited: router.legacyModeInherited,
    });
    return 'created';
  });
}

async function convertOwnerPool(
  conversion: OwnerPoolConversion
): Promise<OwnerPoolConversionResult> {
  const { owner } = conversion;
  const router = convertedOwnerPoolRouter(conversion);
  const result = (outcome: OwnerPoolConversionOutcome): OwnerPoolConversionResult => ({
    owner,
    outcome,
    modelId: router.modelId,
    noticesSent: 0,
    noticesFailed: 0,
  });

  try {
    if (!CustomRouterEntriesSchema.safeParse(router.entries).success) {
      throw new Error('Converted pool entries are not valid custom router entries');
    }
    if (!(await ownerExists(owner))) return result('owner_not_found');
    const outcome = await insertConvertedRouter(owner, router);
    if (outcome === 'router_cap_reached' || outcome === 'slug_taken') {
      warnExceptInTest('Owner pool conversion skipped', {
        outcome,
        ownerType: owner.type,
        ownerId: owner.id,
        ...(outcome === 'router_cap_reached' ? { cap: MAX_CUSTOM_ROUTERS_PER_OWNER } : {}),
      });
    }
    return result(outcome);
  } catch (error) {
    captureException(error, {
      tags: { source: 'auto_routing_owner_pool_conversion' },
      extra: { ownerType: owner.type, ownerId: owner.id },
    });
    return result('failed');
  }
}

export async function convertOwnerPools(
  request: OwnerPoolConversionRequest
): Promise<OwnerPoolConversionResponse> {
  const results: OwnerPoolConversionResult[] = [];
  for (const conversion of request.conversions) {
    results.push(await convertOwnerPool(conversion));
  }
  return { results };
}
