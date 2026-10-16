import 'server-only';

import {
  MAX_CUSTOM_ROUTERS_PER_OWNER,
  convertedOwnerPoolRouter,
  type ConvertedOwnerPoolRouter,
  type OwnerPoolConversion,
  type OwnerPoolConversionOutcome,
  type OwnerPoolConversionOwner,
  type OwnerPoolConversionRequest,
  type OwnerPoolConversionResponse,
  type OwnerPoolConversionResult,
} from '@kilocode/auto-routing-contracts';
import { ORGANIZATION_BILLING_ROLES } from '@kilocode/app-shared/organizations';
import {
  auto_routing_custom_routers,
  kilocode_users,
  organization_memberships,
  organizations,
} from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { sendAutoRoutingPoolConvertedEmail } from '@kilocode/web-shared/lib/email';
import { warnExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import { captureException } from '@sentry/nextjs';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import * as z from 'zod';
import { lockOwner, ownerRouterSlugs } from '@/lib/auto-routing-custom-routers';

type ConvertedOwner =
  | { type: 'user'; email: string }
  | { type: 'org'; organization: { id: string; name: string } };

async function findOwner(owner: OwnerPoolConversionOwner): Promise<ConvertedOwner | null> {
  if (owner.type === 'user') {
    const [user] = await db
      .select({ email: kilocode_users.google_user_email })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, owner.id))
      .limit(1);
    return user ? { type: 'user', email: user.email } : null;
  }
  if (!z.uuid().safeParse(owner.id).success) return null;
  const [organization] = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(and(eq(organizations.id, owner.id), isNull(organizations.deleted_at)))
    .limit(1);
  return organization ? { type: 'org', organization } : null;
}

async function insertConvertedRouter(
  owner: OwnerPoolConversionOwner,
  router: ConvertedOwnerPoolRouter
): Promise<OwnerPoolConversionOutcome> {
  return db.transaction(async tx => {
    await lockOwner(tx, owner);
    const existing = await ownerRouterSlugs(tx, owner);
    if (existing.some(row => row.slug === router.slug)) return 'exists';
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
    });
    return 'created';
  });
}

async function noticeRecipients(owner: ConvertedOwner): Promise<string[]> {
  if (owner.type === 'user') return [owner.email];
  const members = await db
    .select({ email: kilocode_users.google_user_email })
    .from(organization_memberships)
    .innerJoin(kilocode_users, eq(kilocode_users.id, organization_memberships.kilo_user_id))
    .where(
      and(
        eq(organization_memberships.organization_id, owner.organization.id),
        inArray(organization_memberships.role, ORGANIZATION_BILLING_ROLES)
      )
    );
  return members.map(member => member.email);
}

/** A notice failure never undoes the conversion: the router stays and the failure is counted. */
async function sendNotices(
  owner: OwnerPoolConversionOwner,
  converted: ConvertedOwner,
  router: ConvertedOwnerPoolRouter
): Promise<{ noticesSent: number; noticesFailed: number }> {
  const reportFailure = (error: unknown) =>
    captureException(error, {
      tags: { source: 'auto_routing_owner_pool_conversion_notice' },
      extra: { ownerType: owner.type, ownerId: owner.id },
    });

  let recipients: string[];
  try {
    recipients = await noticeRecipients(converted);
  } catch (error) {
    reportFailure(error);
    return { noticesSent: 0, noticesFailed: 1 };
  }

  const outcomes = await Promise.all(
    recipients.map(async to => {
      try {
        const result = await sendAutoRoutingPoolConvertedEmail(to, {
          routerName: router.name,
          modelId: router.modelId,
          organization: converted.type === 'org' ? converted.organization : null,
        });
        if (result.sent) return true;
        warnExceptInTest('Owner pool conversion notice not sent', {
          ownerType: owner.type,
          ownerId: owner.id,
          reason: result.reason,
        });
        return false;
      } catch (error) {
        reportFailure(error);
        return false;
      }
    })
  );
  const noticesSent = outcomes.filter(Boolean).length;
  return { noticesSent, noticesFailed: outcomes.length - noticesSent };
}

async function convertOwnerPool(
  conversion: OwnerPoolConversion
): Promise<OwnerPoolConversionResult> {
  const { owner } = conversion;
  const router = convertedOwnerPoolRouter(conversion);
  const result = (
    outcome: OwnerPoolConversionOutcome,
    notices = { noticesSent: 0, noticesFailed: 0 }
  ): OwnerPoolConversionResult => ({ owner, outcome, modelId: router.modelId, ...notices });

  const converted = await findOwner(owner);
  if (!converted) return result('owner_not_found');

  const outcome = await insertConvertedRouter(owner, router);
  if (outcome === 'router_cap_reached') {
    warnExceptInTest('Owner pool conversion skipped: custom router cap reached', {
      ownerType: owner.type,
      ownerId: owner.id,
      cap: MAX_CUSTOM_ROUTERS_PER_OWNER,
    });
  }
  if (outcome !== 'created') return result(outcome);
  return result(outcome, await sendNotices(owner, converted, router));
}

/** ADR 0005 cutover: each saved owner pool for efficient becomes the owner's `efficient` router. */
export async function convertOwnerPools(
  request: OwnerPoolConversionRequest
): Promise<OwnerPoolConversionResponse> {
  const results: OwnerPoolConversionResult[] = [];
  for (const conversion of request.conversions) {
    results.push(await convertOwnerPool(conversion));
  }
  return { results };
}
