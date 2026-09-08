import 'server-only';

import { createHash } from 'node:crypto';
import { db, type DrizzleTransaction } from '@/lib/drizzle';
import type { Owner } from '@/lib/integrations/core/types';
import {
  github_app_installations,
  platform_integrations,
  provider_oauth_attempts,
} from '@kilocode/db/schema';
import { and, eq, gt, lt, or, sql } from 'drizzle-orm';
import { PLATFORM } from './core/constants';

export type ReservedOAuthProvider = 'slack' | 'linear' | 'discord';
const ATTEMPT_TTL_MS = 10 * 60_000;

const stateHash = (state: string) => createHash('sha256').update(state).digest('hex');
const ownerCondition = (owner: Owner) =>
  owner.type === 'org'
    ? eq(provider_oauth_attempts.owned_by_organization_id, owner.id)
    : eq(provider_oauth_attempts.owned_by_user_id, owner.id);

async function lockOwner(tx: DrizzleTransaction, owner: Owner) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${owner.type}:${owner.id}`}))`);
}

async function assertOwnerHasNoSharedGitHubInstallation(tx: DrizzleTransaction, owner: Owner) {
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
}): Promise<void> {
  await db.transaction(async tx => {
    await lockOwner(tx, input.owner);
    await assertOwnerHasNoSharedGitHubInstallation(tx, input.owner);
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
      state_hash: stateHash(input.state),
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
}): Promise<boolean> {
  return db.transaction(async tx => {
    await lockOwner(tx, input.owner);
    await assertOwnerHasNoSharedGitHubInstallation(tx, input.owner);
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
    const consumed = await tx
      .update(provider_oauth_attempts)
      .set({ status: 'consumed', consumed_at: now })
      .where(
        and(
          ownerCondition(input.owner),
          eq(provider_oauth_attempts.provider, input.provider),
          eq(provider_oauth_attempts.initiated_by_user_id, input.actorUserId),
          eq(provider_oauth_attempts.state_hash, stateHash(input.state)),
          eq(provider_oauth_attempts.status, 'pending'),
          gt(provider_oauth_attempts.expires_at, now)
        )
      )
      .returning({ id: provider_oauth_attempts.id });
    return consumed.length === 1;
  });
}

export async function hasPendingProviderOAuthAttempt(
  tx: DrizzleTransaction,
  owners: Owner[]
): Promise<boolean> {
  const now = new Date().toISOString();
  const conditions = owners.map(owner => ownerCondition(owner));
  await tx
    .update(provider_oauth_attempts)
    .set({ status: 'expired' })
    .where(
      and(
        or(...conditions),
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
