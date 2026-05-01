import {
  markInstanceDestroyedWithPersonalSubscriptionCollapse,
  type KiloClawSubscriptionChangeActor,
} from '@kilocode/db';
import { getWorkerDb, type WorkerDb } from '@kilocode/db/client';
import {
  kilocode_users,
  kiloclaw_access_codes,
  kiloclaw_google_oauth_connections,
  kiloclaw_instances,
} from '@kilocode/db/schema';
import { eq, and, isNull, gt, sql } from 'drizzle-orm';

export { getWorkerDb, type WorkerDb };

const KILOCLAW_WORKER_DESTROY_ACTOR = {
  actorType: 'system',
  actorId: 'kiloclaw-worker',
} satisfies KiloClawSubscriptionChangeActor;

export async function findPepperByUserId(db: WorkerDb, userId: string) {
  const row = await db
    .select({
      id: kilocode_users.id,
      api_token_pepper: kilocode_users.api_token_pepper,
    })
    .from(kilocode_users)
    .where(eq(kilocode_users.id, userId))
    .limit(1)
    .then(rows => rows[0] ?? null);
  return row;
}

export async function findEmailByUserId(db: WorkerDb, userId: string): Promise<string | null> {
  const row = await db
    .select({ email: kilocode_users.google_user_email })
    .from(kilocode_users)
    .where(eq(kilocode_users.id, userId))
    .limit(1)
    .then(rows => rows[0] ?? null);
  return row?.email ?? null;
}

export async function validateAndRedeemAccessCode(db: WorkerDb, code: string, userId: string) {
  return await db.transaction(async tx => {
    const rows = await tx
      .select({
        id: kiloclaw_access_codes.id,
        kilo_user_id: kiloclaw_access_codes.kilo_user_id,
      })
      .from(kiloclaw_access_codes)
      .where(
        and(
          eq(kiloclaw_access_codes.code, code),
          eq(kiloclaw_access_codes.kilo_user_id, userId),
          eq(kiloclaw_access_codes.status, 'active'),
          gt(kiloclaw_access_codes.expires_at, sql`NOW()`)
        )
      )
      .limit(1)
      .for('update');

    if (rows.length === 0) return null;
    const row = rows[0];

    await tx
      .update(kiloclaw_access_codes)
      .set({
        status: 'redeemed',
        redeemed_at: sql`NOW()`,
      })
      .where(eq(kiloclaw_access_codes.id, row.id));

    return row.kilo_user_id;
  });
}

export async function getActivePersonalInstance(db: WorkerDb, userId: string) {
  const row = await db
    .select({
      id: kiloclaw_instances.id,
      sandbox_id: kiloclaw_instances.sandbox_id,
      organization_id: kiloclaw_instances.organization_id,
    })
    .from(kiloclaw_instances)
    .where(
      and(
        eq(kiloclaw_instances.user_id, userId),
        isNull(kiloclaw_instances.organization_id),
        isNull(kiloclaw_instances.destroyed_at)
      )
    )
    .orderBy(kiloclaw_instances.created_at)
    .limit(1)
    .then(rows => rows[0] ?? null);

  if (!row) return null;
  return { id: row.id, sandboxId: row.sandbox_id, orgId: row.organization_id };
}

/**
 * Look up an active instance by its sandboxId.
 * Used for DO restore when the DO has a stored sandboxId but lost other state.
 */
export async function getInstanceBySandboxId(db: WorkerDb, sandboxId: string) {
  const row = await db
    .select({
      id: kiloclaw_instances.id,
      sandbox_id: kiloclaw_instances.sandbox_id,
      user_id: kiloclaw_instances.user_id,
      organization_id: kiloclaw_instances.organization_id,
      provider: kiloclaw_instances.provider,
    })
    .from(kiloclaw_instances)
    .where(
      and(eq(kiloclaw_instances.sandbox_id, sandboxId), isNull(kiloclaw_instances.destroyed_at))
    )
    .limit(1)
    .then(rows => rows[0] ?? null);

  if (!row) return null;
  return {
    id: row.id,
    sandboxId: row.sandbox_id,
    userId: row.user_id,
    orgId: row.organization_id,
    provider: row.provider,
  };
}

/**
 * Look up an active instance by its primary key UUID.
 * Used for DO restore when the caller knows the instanceId (= DB row id).
 */
export async function getInstanceById(db: WorkerDb, instanceId: string) {
  return getInstanceByIdIncludingDestroyed(db, instanceId, { includeDestroyed: false });
}

export async function getInstanceByIdIncludingDestroyed(
  db: WorkerDb,
  instanceId: string,
  options: { includeDestroyed?: boolean } = {}
) {
  const where = options.includeDestroyed
    ? eq(kiloclaw_instances.id, instanceId)
    : and(eq(kiloclaw_instances.id, instanceId), isNull(kiloclaw_instances.destroyed_at));

  const row = await db
    .select({
      id: kiloclaw_instances.id,
      sandbox_id: kiloclaw_instances.sandbox_id,
      user_id: kiloclaw_instances.user_id,
      organization_id: kiloclaw_instances.organization_id,
      inbound_email_enabled: kiloclaw_instances.inbound_email_enabled,
      provider: kiloclaw_instances.provider,
    })
    .from(kiloclaw_instances)
    .where(where)
    .limit(1)
    .then(rows => rows[0] ?? null);

  if (!row) return null;
  return {
    id: row.id,
    sandboxId: row.sandbox_id,
    userId: row.user_id,
    orgId: row.organization_id,
    inboundEmailEnabled: row.inbound_email_enabled,
    provider: row.provider,
  };
}

export async function markInstanceDestroyed(db: WorkerDb, userId: string, sandboxId: string) {
  await db.transaction(async tx => {
    const row = await tx
      .select({
        id: kiloclaw_instances.id,
      })
      .from(kiloclaw_instances)
      .where(
        and(
          eq(kiloclaw_instances.user_id, userId),
          eq(kiloclaw_instances.sandbox_id, sandboxId),
          isNull(kiloclaw_instances.destroyed_at)
        )
      )
      .limit(1)
      .then(rows => rows[0] ?? null);

    if (!row) {
      return;
    }

    await markInstanceDestroyedWithPersonalSubscriptionCollapse({
      actor: KILOCLAW_WORKER_DESTROY_ACTOR,
      executor: tx,
      instanceId: row.id,
      reason: 'destroy_path_inline_collapse',
      userId,
    });
  });
}

/**
 * Sync the active instance's tracked_image_tag column from DO state.
 * No-op at the SQL level when the value already matches (IS DISTINCT FROM).
 */
export async function syncTrackedImageTag(
  db: WorkerDb,
  userId: string,
  sandboxId: string,
  trackedImageTag: string | null
) {
  await db
    .update(kiloclaw_instances)
    .set({ tracked_image_tag: trackedImageTag })
    .where(
      and(
        eq(kiloclaw_instances.user_id, userId),
        eq(kiloclaw_instances.sandbox_id, sandboxId),
        isNull(kiloclaw_instances.destroyed_at),
        sql`${kiloclaw_instances.tracked_image_tag} IS DISTINCT FROM ${trackedImageTag}`
      )
    );
}

export async function getGoogleOAuthConnectionByInstanceId(db: WorkerDb, instanceId: string) {
  return await db
    .select()
    .from(kiloclaw_google_oauth_connections)
    .where(eq(kiloclaw_google_oauth_connections.instance_id, instanceId))
    .limit(1)
    .then(rows => rows[0] ?? null);
}

export async function updateGoogleOAuthConnectionTokenData(
  db: WorkerDb,
  instanceId: string,
  patch: {
    refreshTokenEncrypted?: string;
    oauthClientId?: string;
    oauthClientSecretEncrypted?: string | null;
    credentialProfile?: 'legacy' | 'kilo_owned';
    scopes?: string[];
    status?: 'active' | 'action_required' | 'disconnected';
    lastError?: string | null;
    lastErrorAt?: string | null;
  }
) {
  const update: Record<string, unknown> = {
    updated_at: sql`NOW()`,
  };

  if (patch.refreshTokenEncrypted !== undefined) {
    update.refresh_token_encrypted = patch.refreshTokenEncrypted;
  }

  if (patch.oauthClientId !== undefined) {
    update.oauth_client_id = patch.oauthClientId;
  }

  if (patch.oauthClientSecretEncrypted !== undefined) {
    update.oauth_client_secret_encrypted = patch.oauthClientSecretEncrypted;
  }

  if (patch.credentialProfile !== undefined) {
    update.credential_profile = patch.credentialProfile;
  }

  if (patch.scopes !== undefined) {
    update.scopes = patch.scopes;
  }

  if (patch.status !== undefined) {
    update.status = patch.status;
  }

  if (patch.lastError !== undefined) {
    update.last_error = patch.lastError;
  }

  if (patch.lastErrorAt !== undefined) {
    update.last_error_at = patch.lastErrorAt;
  }

  await db
    .update(kiloclaw_google_oauth_connections)
    .set(update)
    .where(eq(kiloclaw_google_oauth_connections.instance_id, instanceId));
}
