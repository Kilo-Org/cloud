import 'server-only';

import { createHash } from 'node:crypto';
import { db, type DrizzleTransaction } from '@/lib/drizzle';
import type { Owner } from '@/lib/integrations/core/types';
import {
  github_app_installations,
  kilocode_users,
  organizations,
  platform_integrations,
  provider_oauth_attempts,
} from '@kilocode/db/schema';
import { and, eq, gt, lt, ne, or, sql } from 'drizzle-orm';
import { PLATFORM } from './core/constants';

export type ReservedOAuthProvider = 'slack' | 'linear' | 'discord';
const ATTEMPT_TTL_MS = 10 * 60_000;

export const providerOAuthStateHash = (state: string) =>
  createHash('sha256').update(state).digest('hex');
const ownerCondition = (owner: Owner) =>
  owner.type === 'org'
    ? eq(provider_oauth_attempts.owned_by_organization_id, owner.id)
    : eq(provider_oauth_attempts.owned_by_user_id, owner.id);

export async function lockProviderOAuthOwnerRow(tx: DrizzleTransaction, owner: Owner) {
  await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
  await tx.execute(sql`SET LOCAL statement_timeout = '30s'`);
  const rows =
    owner.type === 'org'
      ? await tx
          .select({ id: organizations.id })
          .from(organizations)
          .where(eq(organizations.id, owner.id))
          .for('update')
      : await tx
          .select({ id: kilocode_users.id })
          .from(kilocode_users)
          .where(eq(kilocode_users.id, owner.id))
          .for('update');
  if (rows.length !== 1) throw new Error('OAuth destination owner not found');
}

export async function pruneProviderOAuthAttempts(tx: DrizzleTransaction): Promise<void> {
  const now = new Date().toISOString();
  await tx.execute(
    sql`WITH expired AS (SELECT id FROM ${provider_oauth_attempts} WHERE status IN ('pending', 'captured', 'consumed') AND expires_at < ${now} ORDER BY expires_at LIMIT 100) UPDATE ${provider_oauth_attempts} attempts SET status = 'expired' FROM expired WHERE attempts.id = expired.id`
  );
  await tx.execute(
    sql`DELETE FROM ${provider_oauth_attempts} WHERE id IN (SELECT id FROM ${provider_oauth_attempts} WHERE status = 'expired' AND expires_at < ${new Date(Date.now() - 24 * 60 * 60_000).toISOString()} ORDER BY expires_at LIMIT 100)`
  );
}

async function assertOwnerCanUseProvider(
  tx: DrizzleTransaction,
  owner: Owner,
  provider: ReservedOAuthProvider
) {
  if (provider === 'slack') return;
  const [shared] = await tx
    .select({ id: platform_integrations.id })
    .from(platform_integrations)
    .innerJoin(
      github_app_installations,
      eq(platform_integrations.github_installation_id, github_app_installations.id)
    )
    .where(
      and(
        owner.type === 'org'
          ? eq(platform_integrations.owned_by_organization_id, owner.id)
          : eq(platform_integrations.owned_by_user_id, owner.id),
        eq(platform_integrations.platform, PLATFORM.GITHUB),
        eq(github_app_installations.sharing_mode, 'web_cloud_agent')
      )
    )
    .limit(1);
  if (shared) throw new Error('This workflow is not available for shared GitHub installations yet');
}

export async function beginProviderOAuthAttempt(input: {
  actorUserId: string;
  owner: Owner;
  provider: ReservedOAuthProvider;
  state: string;
  purpose?: 'provider_install';
}): Promise<void> {
  await db.transaction(async tx => {
    await lockProviderOAuthOwnerRow(tx, input.owner);
    await pruneProviderOAuthAttempts(tx);
    await assertOwnerCanUseProvider(tx, input.owner, input.provider);
    const now = new Date().toISOString();
    await tx
      .update(provider_oauth_attempts)
      .set({ status: 'expired' })
      .where(
        and(
          ownerCondition(input.owner),
          eq(provider_oauth_attempts.provider, input.provider),
          or(
            eq(provider_oauth_attempts.status, 'pending'),
            eq(provider_oauth_attempts.status, 'consumed')
          ),
          lt(provider_oauth_attempts.expires_at, now)
        )
      );
    await tx.insert(provider_oauth_attempts).values({
      provider: input.provider,
      purpose: input.purpose ?? 'provider_install',
      state_hash: providerOAuthStateHash(input.state),
      initiated_by_user_id: input.actorUserId,
      owned_by_user_id: input.owner.type === 'user' ? input.owner.id : null,
      owned_by_organization_id: input.owner.type === 'org' ? input.owner.id : null,
      expires_at: new Date(Date.now() + ATTEMPT_TTL_MS).toISOString(),
    });
  });
}

export async function consumeProviderOAuthAttempt(input: {
  actorUserId: string;
  owner: Owner;
  provider: ReservedOAuthProvider;
  state: string;
  purpose?: 'provider_install';
}): Promise<boolean> {
  return db.transaction(async tx => {
    await lockProviderOAuthOwnerRow(tx, input.owner);
    await pruneProviderOAuthAttempts(tx);
    await assertOwnerCanUseProvider(tx, input.owner, input.provider);
    const now = new Date().toISOString();
    await tx
      .update(provider_oauth_attempts)
      .set({ status: 'expired' })
      .where(
        and(
          ownerCondition(input.owner),
          eq(provider_oauth_attempts.provider, input.provider),
          eq(provider_oauth_attempts.purpose, input.purpose ?? 'provider_install'),
          or(
            eq(provider_oauth_attempts.status, 'pending'),
            eq(provider_oauth_attempts.status, 'consumed')
          ),
          lt(provider_oauth_attempts.expires_at, now)
        )
      );
    const consumed = await tx
      .update(provider_oauth_attempts)
      .set({ status: 'consumed', consumed_at: now })
      .where(
        and(
          ownerCondition(input.owner),
          eq(provider_oauth_attempts.provider, input.provider),
          eq(provider_oauth_attempts.initiated_by_user_id, input.actorUserId),
          eq(provider_oauth_attempts.state_hash, providerOAuthStateHash(input.state)),
          eq(provider_oauth_attempts.status, 'pending'),
          gt(provider_oauth_attempts.expires_at, now)
        )
      )
      .returning({ id: provider_oauth_attempts.id });
    return consumed.length === 1;
  });
}

export async function cancelProviderOAuthAttempt(input: {
  actorUserId: string;
  owner: Owner;
  provider: ReservedOAuthProvider;
  state: string;
  purpose: 'provider_install';
}): Promise<boolean> {
  return db.transaction(async tx => {
    await lockProviderOAuthOwnerRow(tx, input.owner);
    await pruneProviderOAuthAttempts(tx);
    const cancelled = await tx
      .update(provider_oauth_attempts)
      .set({ status: 'expired' })
      .where(
        and(
          ownerCondition(input.owner),
          eq(provider_oauth_attempts.provider, input.provider),
          eq(provider_oauth_attempts.purpose, input.purpose),
          eq(provider_oauth_attempts.initiated_by_user_id, input.actorUserId),
          eq(provider_oauth_attempts.state_hash, providerOAuthStateHash(input.state)),
          eq(provider_oauth_attempts.status, 'pending')
        )
      )
      .returning({ id: provider_oauth_attempts.id });
    return cancelled.length === 1;
  });
}

export async function hasPendingProviderOAuthAttempt(
  tx: DrizzleTransaction,
  owners: Owner[]
): Promise<boolean> {
  const now = new Date().toISOString();
  await pruneProviderOAuthAttempts(tx);
  const conditions = owners.map(owner => ownerCondition(owner));
  await tx
    .update(provider_oauth_attempts)
    .set({ status: 'expired' })
    .where(
      and(
        or(...conditions),
        ne(provider_oauth_attempts.provider, 'slack'),
        or(
          eq(provider_oauth_attempts.status, 'pending'),
          eq(provider_oauth_attempts.status, 'consumed')
        ),
        lt(provider_oauth_attempts.expires_at, now)
      )
    );
  const [attempt] = await tx
    .select({ id: provider_oauth_attempts.id })
    .from(provider_oauth_attempts)
    .where(
      and(
        or(...conditions),
        ne(provider_oauth_attempts.provider, 'slack'),
        or(
          eq(provider_oauth_attempts.status, 'pending'),
          eq(provider_oauth_attempts.status, 'consumed')
        ),
        gt(provider_oauth_attempts.expires_at, now)
      )
    )
    .limit(1);
  return Boolean(attempt);
}
