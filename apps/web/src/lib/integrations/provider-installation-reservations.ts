import 'server-only';

import { and, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
import {
  bot_requests,
  platform_integrations,
  provider_installation_pending_credentials,
  provider_installation_aliases,
  provider_installation_reservations,
  provider_oauth_attempts,
} from '@kilocode/db/schema';
import { db, type DrizzleTransaction } from '@/lib/drizzle';
import type { Owner } from '@/lib/integrations/core/types';
import { lockProviderOAuthOwnerRow, providerOAuthStateHash } from './provider-oauth-attempts';

const RESERVATION_TTL_MS = 10 * 60_000;

const ownerCondition = (owner: Owner) =>
  owner.type === 'org'
    ? eq(provider_installation_reservations.owned_by_organization_id, owner.id)
    : eq(provider_installation_reservations.owned_by_user_id, owner.id);

const attemptOwnerCondition = (owner: Owner) =>
  owner.type === 'org'
    ? eq(provider_oauth_attempts.owned_by_organization_id, owner.id)
    : eq(provider_oauth_attempts.owned_by_user_id, owner.id);

export type SlackReservationClaim = {
  reservationId: string;
  attemptId: string | null;
  generation: number;
};

export async function claimSlackProviderInstallation(input: {
  actorUserId: string;
  owner: Owner;
  state: string;
  teamId: string;
}): Promise<SlackReservationClaim | null> {
  await expireStaleSlackReservation(input.teamId);
  try {
    return await db.transaction(async tx => {
      await lockProviderOAuthOwnerRow(tx, input.owner);
      const now = new Date().toISOString();
      const [attempt] = await tx
        .select()
        .from(provider_oauth_attempts)
        .where(
          and(
            attemptOwnerCondition(input.owner),
            eq(provider_oauth_attempts.provider, 'slack'),
            eq(provider_oauth_attempts.purpose, 'provider_install'),
            eq(provider_oauth_attempts.initiated_by_user_id, input.actorUserId),
            eq(provider_oauth_attempts.state_hash, providerOAuthStateHash(input.state)),
            eq(provider_oauth_attempts.status, 'pending'),
            gt(provider_oauth_attempts.expires_at, now)
          )
        )
        .for('update');
      if (!attempt) return null;

      const [reservation] = await tx
        .select()
        .from(provider_installation_reservations)
        .where(
          and(
            eq(provider_installation_reservations.provider, 'slack'),
            eq(provider_installation_reservations.provider_installation_id, input.teamId)
          )
        )
        .for('update');

      if (reservation?.status === 'active' && !matchesOwner(reservation, input.owner)) return null;
      if (reservation?.status === 'deleting') return null;
      if (
        reservation?.status === 'pending' &&
        !matchesOwner(reservation, input.owner) &&
        new Date(reservation.expires_at) > new Date(now)
      ) {
        return null;
      }

      const generation = (reservation?.generation ?? 0) + 1;
      const activeGeneration =
        reservation?.status === 'active'
          ? reservation.generation
          : (reservation?.active_generation ?? null);
      const expiresAt = new Date(Date.now() + RESERVATION_TTL_MS).toISOString();
      const values = {
        owned_by_user_id: input.owner.type === 'user' ? input.owner.id : null,
        owned_by_organization_id: input.owner.type === 'org' ? input.owner.id : null,
        platform_integration_id:
          reservation?.status === 'active' || reservation?.active_generation
            ? reservation.platform_integration_id
            : null,
        oauth_attempt_id: attempt.id,
        generation,
        active_generation: activeGeneration,
        status: 'pending' as const,
        expires_at: expiresAt,
        updated_at: now,
      };
      const [claimed] = reservation
        ? await tx
            .update(provider_installation_reservations)
            .set(values)
            .where(eq(provider_installation_reservations.id, reservation.id))
            .returning({ id: provider_installation_reservations.id })
        : await tx
            .insert(provider_installation_reservations)
            .values({
              provider: 'slack',
              provider_installation_id: input.teamId,
              ...values,
            })
            .returning({ id: provider_installation_reservations.id });

      await tx
        .update(provider_oauth_attempts)
        .set({
          status: 'captured',
          provider_installation_id: input.teamId,
          generation,
        })
        .where(
          and(
            eq(provider_oauth_attempts.id, attempt.id),
            eq(provider_oauth_attempts.status, 'pending')
          )
        );

      return { reservationId: claimed.id, attemptId: attempt.id, generation };
    });
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'constraint' in error &&
      error.constraint === 'UQ_provider_installation_reservations_identity'
    ) {
      return null;
    }
    throw error;
  }
}

export async function recordSlackInstallationAlias(input: {
  workspaceId: string;
  installationId: string;
  eventTime?: number;
}): Promise<void> {
  const eventTime = input.eventTime;
  if (input.workspaceId === input.installationId || eventTime === undefined) return;
  const [candidate] = await db
    .select()
    .from(provider_installation_reservations)
    .where(
      and(
        eq(provider_installation_reservations.provider, 'slack'),
        eq(provider_installation_reservations.provider_installation_id, input.installationId),
        or(
          eq(provider_installation_reservations.status, 'active'),
          and(
            eq(provider_installation_reservations.status, 'pending'),
            sql`${provider_installation_reservations.active_generation} IS NOT NULL`
          )
        )
      )
    )
    .limit(1);
  if (!candidate) return;
  const owner: Owner | null = candidate.owned_by_organization_id
    ? { type: 'org', id: candidate.owned_by_organization_id }
    : candidate.owned_by_user_id
      ? { type: 'user', id: candidate.owned_by_user_id }
      : null;
  if (!owner) return;
  await db.transaction(async tx => {
    await lockProviderOAuthOwnerRow(tx, owner);
    const [reservation] = await tx
      .select()
      .from(provider_installation_reservations)
      .where(eq(provider_installation_reservations.id, candidate.id))
      .for('update');
    if (!reservation) return;
    const generation = reservation.active_generation ?? reservation.generation;
    const [existing] = await tx
      .select()
      .from(provider_installation_aliases)
      .where(eq(provider_installation_aliases.workspace_id, input.workspaceId))
      .for('update');
    if (
      existing &&
      (existing.event_time > eventTime ||
        (existing.event_time === eventTime &&
          (existing.reservation_id !== reservation.id || existing.generation !== generation)))
    ) {
      return;
    }
    await tx
      .insert(provider_installation_aliases)
      .values({
        workspace_id: input.workspaceId,
        reservation_id: reservation.id,
        generation,
        event_time: eventTime,
      })
      .onConflictDoUpdate({
        target: provider_installation_aliases.workspace_id,
        set: {
          reservation_id: reservation.id,
          generation,
          event_time: eventTime,
          updated_at: new Date().toISOString(),
        },
        setWhere: or(
          lt(provider_installation_aliases.event_time, eventTime),
          and(
            eq(provider_installation_aliases.event_time, eventTime),
            eq(provider_installation_aliases.reservation_id, reservation.id),
            eq(provider_installation_aliases.generation, generation)
          )
        ),
      });
  });
}

export async function resolveSlackInstallationAlias(workspaceId: string): Promise<string> {
  const [alias] = await db
    .select({ installationId: provider_installation_reservations.provider_installation_id })
    .from(provider_installation_aliases)
    .innerJoin(
      provider_installation_reservations,
      and(
        eq(provider_installation_aliases.reservation_id, provider_installation_reservations.id),
        eq(
          provider_installation_aliases.generation,
          sql`coalesce(${provider_installation_reservations.active_generation}, ${provider_installation_reservations.generation})`
        )
      )
    )
    .where(eq(provider_installation_aliases.workspace_id, workspaceId))
    .limit(1);
  return alias?.installationId ?? workspaceId;
}

export async function claimLegacySlackProviderInstallation(
  owner: Owner,
  teamId: string
): Promise<SlackReservationClaim | null> {
  await expireStaleSlackReservation(teamId);
  try {
    return await db.transaction(async tx => {
      await lockProviderOAuthOwnerRow(tx, owner);
      const now = new Date().toISOString();
      const [reservation] = await tx
        .select()
        .from(provider_installation_reservations)
        .where(
          and(
            eq(provider_installation_reservations.provider, 'slack'),
            eq(provider_installation_reservations.provider_installation_id, teamId)
          )
        )
        .for('update');
      if (reservation && !matchesOwner(reservation, owner)) return null;
      if (reservation?.status === 'deleting') return null;
      const generation = (reservation?.generation ?? 0) + 1;
      const activeGeneration =
        reservation?.status === 'active'
          ? reservation.generation
          : (reservation?.active_generation ?? null);
      const values = {
        owned_by_user_id: owner.type === 'user' ? owner.id : null,
        owned_by_organization_id: owner.type === 'org' ? owner.id : null,
        platform_integration_id:
          reservation?.status === 'active' || reservation?.active_generation
            ? reservation.platform_integration_id
            : null,
        oauth_attempt_id: null,
        generation,
        active_generation: activeGeneration,
        status: 'pending' as const,
        expires_at: new Date(Date.now() + RESERVATION_TTL_MS).toISOString(),
        updated_at: now,
      };
      const [claimed] = reservation
        ? await tx
            .update(provider_installation_reservations)
            .set(values)
            .where(eq(provider_installation_reservations.id, reservation.id))
            .returning({ id: provider_installation_reservations.id })
        : await tx
            .insert(provider_installation_reservations)
            .values({ provider: 'slack', provider_installation_id: teamId, ...values })
            .returning({ id: provider_installation_reservations.id });
      return { reservationId: claimed.id, attemptId: null, generation };
    });
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'constraint' in error &&
      error.constraint === 'UQ_provider_installation_reservations_identity'
    ) {
      return null;
    }
    throw error;
  }
}

function matchesOwner(
  reservation: typeof provider_installation_reservations.$inferSelect,
  owner: Owner
): boolean {
  return owner.type === 'org'
    ? reservation.owned_by_organization_id === owner.id && reservation.owned_by_user_id === null
    : reservation.owned_by_user_id === owner.id && reservation.owned_by_organization_id === null;
}

export async function lockSlackReservation(
  tx: DrizzleTransaction,
  claim: SlackReservationClaim,
  owner: Owner,
  teamId: string
) {
  const [reservation] = await tx
    .select()
    .from(provider_installation_reservations)
    .where(
      and(
        eq(provider_installation_reservations.id, claim.reservationId),
        eq(provider_installation_reservations.provider, 'slack'),
        eq(provider_installation_reservations.provider_installation_id, teamId),
        claim.attemptId
          ? eq(provider_installation_reservations.oauth_attempt_id, claim.attemptId)
          : isNull(provider_installation_reservations.oauth_attempt_id),
        eq(provider_installation_reservations.generation, claim.generation),
        eq(provider_installation_reservations.status, 'pending'),
        ownerCondition(owner),
        gt(provider_installation_reservations.expires_at, new Date().toISOString())
      )
    )
    .for('update');
  return reservation ?? null;
}

export async function activateSlackReservation(
  tx: DrizzleTransaction,
  claim: SlackReservationClaim,
  integrationId: string
): Promise<boolean> {
  const now = new Date().toISOString();
  const activated = await tx
    .update(provider_installation_reservations)
    .set({
      platform_integration_id: integrationId,
      status: 'active',
      active_generation: claim.generation,
      expires_at: new Date('9999-12-31T23:59:59.999Z').toISOString(),
      updated_at: now,
    })
    .where(
      and(
        eq(provider_installation_reservations.id, claim.reservationId),
        claim.attemptId
          ? eq(provider_installation_reservations.oauth_attempt_id, claim.attemptId)
          : isNull(provider_installation_reservations.oauth_attempt_id),
        eq(provider_installation_reservations.generation, claim.generation),
        eq(provider_installation_reservations.status, 'pending')
      )
    )
    .returning({ id: provider_installation_reservations.id });
  if (activated.length !== 1) return false;
  if (!claim.attemptId) return true;
  const completed = await tx
    .update(provider_oauth_attempts)
    .set({
      status: 'consumed',
      consumed_at: now,
      completed_integration_id: integrationId,
    })
    .where(
      and(
        eq(provider_oauth_attempts.id, claim.attemptId),
        eq(provider_oauth_attempts.status, 'captured'),
        eq(provider_oauth_attempts.generation, claim.generation)
      )
    )
    .returning({ id: provider_oauth_attempts.id });
  return completed.length === 1;
}

export async function adoptLegacySlackReservation(
  owner: Owner,
  integrationId: string,
  teamId: string
): Promise<void> {
  const [existing] = await db
    .select({ id: provider_installation_reservations.id })
    .from(provider_installation_reservations)
    .where(
      and(
        eq(provider_installation_reservations.provider, 'slack'),
        eq(provider_installation_reservations.provider_installation_id, teamId)
      )
    )
    .limit(1);
  if (existing) return;
  await db.transaction(async tx => {
    await lockProviderOAuthOwnerRow(tx, owner);
    const [integration] = await tx
      .select({ id: platform_integrations.id })
      .from(platform_integrations)
      .where(
        and(
          eq(platform_integrations.id, integrationId),
          eq(platform_integrations.platform, 'slack'),
          eq(platform_integrations.integration_status, 'active')
        )
      )
      .for('update');
    if (!integration) return;
    await tx
      .insert(provider_installation_reservations)
      .values({
        provider: 'slack',
        provider_installation_id: teamId,
        owned_by_user_id: owner.type === 'user' ? owner.id : null,
        owned_by_organization_id: owner.type === 'org' ? owner.id : null,
        platform_integration_id: integrationId,
        generation: 1,
        active_generation: 1,
        status: 'active',
        expires_at: '9999-12-31T23:59:59.999Z',
      })
      .onConflictDoNothing();
  });
}

export async function expireSlackReservations(input: {
  owner?: Owner;
  teamId?: string;
}): Promise<void> {
  await db.transaction(async tx => {
    if (input.owner) await lockProviderOAuthOwnerRow(tx, input.owner);
    const condition = input.teamId
      ? and(
          eq(provider_installation_reservations.provider, 'slack'),
          eq(provider_installation_reservations.provider_installation_id, input.teamId)
        )
      : input.owner
        ? and(eq(provider_installation_reservations.provider, 'slack'), ownerCondition(input.owner))
        : undefined;
    if (!condition) return;
    const reservations = await tx
      .select({ attemptId: provider_installation_reservations.oauth_attempt_id })
      .from(provider_installation_reservations)
      .where(condition)
      .for('update');
    await tx.delete(provider_installation_reservations).where(condition);
    const attemptIds = reservations.flatMap(row => (row.attemptId ? [row.attemptId] : []));
    if (attemptIds.length > 0) {
      await tx
        .update(provider_oauth_attempts)
        .set({ status: 'expired' })
        .where(
          and(
            or(...attemptIds.map(id => eq(provider_oauth_attempts.id, id))),
            or(
              eq(provider_oauth_attempts.status, 'pending'),
              eq(provider_oauth_attempts.status, 'captured')
            )
          )
        );
    }
  });
}

export async function expireStaleSlackReservation(teamId: string): Promise<void> {
  const now = new Date().toISOString();
  const [candidate] = await db
    .select()
    .from(provider_installation_reservations)
    .where(
      and(
        eq(provider_installation_reservations.provider, 'slack'),
        eq(provider_installation_reservations.provider_installation_id, teamId),
        eq(provider_installation_reservations.status, 'pending'),
        lt(provider_installation_reservations.expires_at, now)
      )
    )
    .limit(1);
  if (!candidate) return;
  const owner: Owner | null = candidate.owned_by_organization_id
    ? { type: 'org', id: candidate.owned_by_organization_id }
    : candidate.owned_by_user_id
      ? { type: 'user', id: candidate.owned_by_user_id }
      : null;
  if (!owner) return;
  await db.transaction(async tx => {
    await lockProviderOAuthOwnerRow(tx, owner);
    const [reservation] = await tx
      .select()
      .from(provider_installation_reservations)
      .where(
        and(
          eq(provider_installation_reservations.id, candidate.id),
          eq(provider_installation_reservations.status, 'pending'),
          lt(provider_installation_reservations.expires_at, now)
        )
      )
      .for('update');
    if (!reservation) return;
    await tx
      .delete(provider_installation_pending_credentials)
      .where(
        and(
          eq(provider_installation_pending_credentials.reservation_id, reservation.id),
          eq(provider_installation_pending_credentials.generation, reservation.generation)
        )
      );
    if (reservation.active_generation && reservation.platform_integration_id) {
      await tx
        .update(provider_installation_reservations)
        .set({
          generation: reservation.active_generation,
          status: 'active',
          oauth_attempt_id: null,
          expires_at: '9999-12-31T23:59:59.999Z',
          updated_at: now,
        })
        .where(eq(provider_installation_reservations.id, reservation.id));
      return;
    }
    if (reservation.platform_integration_id) {
      const [integration] = await tx
        .select()
        .from(platform_integrations)
        .where(eq(platform_integrations.id, reservation.platform_integration_id))
        .for('update');
      if (integration?.integration_status === 'pending') {
        const [history] = await tx
          .select({ id: bot_requests.id })
          .from(bot_requests)
          .where(eq(bot_requests.platform_integration_id, integration.id))
          .limit(1);
        if (history) {
          await tx
            .update(platform_integrations)
            .set({
              integration_status: 'suspended',
              platform_installation_id: null,
              platform_account_id: null,
              suspended_at: now,
              updated_at: now,
            })
            .where(eq(platform_integrations.id, integration.id));
          await tx
            .delete(provider_installation_reservations)
            .where(eq(provider_installation_reservations.id, reservation.id));
          return;
        }
        await tx.delete(platform_integrations).where(eq(platform_integrations.id, integration.id));
        return;
      }
    }
    await tx
      .delete(provider_installation_reservations)
      .where(eq(provider_installation_reservations.id, reservation.id));
  });
}

export async function getRecoverableSlackReservation(teamId: string): Promise<{
  owner: Owner;
  claim: SlackReservationClaim;
} | null> {
  const [row] = await db
    .select({
      reservation: provider_installation_reservations,
    })
    .from(provider_installation_reservations)
    .leftJoin(
      provider_oauth_attempts,
      eq(provider_installation_reservations.oauth_attempt_id, provider_oauth_attempts.id)
    )
    .where(
      and(
        eq(provider_installation_reservations.provider, 'slack'),
        eq(provider_installation_reservations.provider_installation_id, teamId),
        eq(provider_installation_reservations.status, 'pending'),
        gt(provider_installation_reservations.expires_at, new Date().toISOString()),
        or(
          isNull(provider_installation_reservations.oauth_attempt_id),
          eq(provider_oauth_attempts.status, 'captured')
        )
      )
    )
    .limit(1);
  if (!row) return null;
  const owner: Owner | null = row.reservation.owned_by_organization_id
    ? { type: 'org', id: row.reservation.owned_by_organization_id }
    : row.reservation.owned_by_user_id
      ? { type: 'user', id: row.reservation.owned_by_user_id }
      : null;
  if (!owner) return null;
  return {
    owner,
    claim: {
      reservationId: row.reservation.id,
      attemptId: row.reservation.oauth_attempt_id,
      generation: row.reservation.generation,
    },
  };
}
