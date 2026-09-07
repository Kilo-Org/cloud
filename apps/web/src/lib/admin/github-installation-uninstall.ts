import 'server-only';

import { and, eq, isNull, or } from 'drizzle-orm';
import { captureException } from '@sentry/nextjs';
import { TRPCError } from '@trpc/server';
import { db, type DrizzleTransaction } from '@/lib/drizzle';
import { createAuditLog } from '@/lib/organizations/organization-audit-logs';
import { verifyAndDeleteGitHubOrganizationInstallation } from '@/lib/integrations/platforms/github/adapter';
import { kilocode_users, platform_integrations, user_admin_notes } from '@kilocode/db/schema';
import type { GitHubInstallationUninstallInput } from './github-installation-uninstall-input';

const RETRY_MESSAGE =
  'GitHub installation uninstall could not be confirmed. Refresh before retrying.';

type Actor = { id: string; email: string; name: string | null };
type LocalRecord = {
  id: string;
  ownerType: 'user' | 'organization';
  ownerId: string;
  appType: 'standard' | 'lite';
  installationId: string;
  accountId: string;
};

function uninstallError(code: 'BAD_REQUEST' | 'FORBIDDEN' | 'CONFLICT' = 'CONFLICT') {
  return new TRPCError({ code, message: RETRY_MESSAGE });
}

type AuditStatus = 'attempted' | 'confirmed' | 'unconfirmed' | 'confirmed; local cleanup pending';

function auditMessage(record: LocalRecord, status: AuditStatus) {
  return `GitHub ${record.appType} App integration ${record.id} installation ${record.installationId} (${record.accountId}) uninstall ${status}.`;
}

async function writeAudit(
  executor: typeof db | DrizzleTransaction,
  actor: Actor,
  record: LocalRecord,
  status: AuditStatus
) {
  if (record.ownerType === 'organization') {
    const audit = {
      organization_id: record.ownerId,
      action: 'organization.settings.change',
      actor_id: actor.id,
      actor_email: actor.email,
      actor_name: actor.name,
      message: auditMessage(record, status),
    } as const;
    if (executor === db) await createAuditLog(audit);
    else await createAuditLog({ ...audit, tx: executor as DrizzleTransaction });
    return;
  }
  await executor.insert(user_admin_notes).values({
    kilo_user_id: record.ownerId,
    admin_kilo_user_id: actor.id,
    note_content: auditMessage(record, status),
  });
}

async function tryWriteAudit(params: { actor: Actor; record: LocalRecord; status: AuditStatus }) {
  try {
    await writeAudit(db, params.actor, params.record, params.status);
  } catch (error) {
    captureException(error, {
      tags: {
        operation: 'github-installation-uninstall-audit',
        audit_status: params.status.replaceAll(/[^a-z]+/g, '_').replaceAll(/^_|_$/g, ''),
      },
      extra: {
        integrationId: params.record.id,
        ownerType: params.record.ownerType,
      },
    });
  }
}

function recordMatchesInput(record: LocalRecord, input: GitHubInstallationUninstallInput) {
  return (
    record.id === input.integrationId &&
    record.ownerType === input.owner.type &&
    record.ownerId === input.owner.id &&
    record.appType === input.appType &&
    record.installationId === input.installationId &&
    record.accountId === input.accountId
  );
}

async function lockRecord(tx: DrizzleTransaction, input: GitHubInstallationUninstallInput) {
  const rows = await tx
    .select({
      id: platform_integrations.id,
      platform: platform_integrations.platform,
      userId: platform_integrations.owned_by_user_id,
      organizationId: platform_integrations.owned_by_organization_id,
      appType: platform_integrations.github_app_type,
      installationId: platform_integrations.platform_installation_id,
      accountId: platform_integrations.platform_account_id,
    })
    .from(platform_integrations)
    .where(eq(platform_integrations.id, input.integrationId))
    .for('update');
  const row = rows[0];
  if (
    !row ||
    row.platform !== 'github' ||
    !row.installationId ||
    !row.accountId ||
    (!row.userId && !row.organizationId) ||
    (row.userId && row.organizationId)
  ) {
    throw uninstallError();
  }
  const record: LocalRecord = {
    id: row.id,
    ownerType: row.userId ? 'user' : 'organization',
    ownerId: row.userId ?? row.organizationId ?? '',
    appType: row.appType ?? 'standard',
    installationId: row.installationId,
    accountId: row.accountId,
  };
  if (!recordMatchesInput(record, input)) throw uninstallError();
  return record;
}

async function rejectEffectiveDuplicates(tx: DrizzleTransaction, record: LocalRecord) {
  const rows = await tx
    .select({ id: platform_integrations.id })
    .from(platform_integrations)
    .where(
      and(
        eq(platform_integrations.platform, 'github'),
        eq(platform_integrations.platform_installation_id, record.installationId),
        record.appType === 'standard'
          ? or(
              eq(platform_integrations.github_app_type, 'standard'),
              isNull(platform_integrations.github_app_type)
            )
          : eq(platform_integrations.github_app_type, 'lite')
      )
    )
    .limit(2);
  if (rows.length !== 1 || rows[0]?.id !== record.id) throw uninstallError();
}

async function requireFreshActiveAdmin(tx: DrizzleTransaction, actorId: string) {
  const [admin] = await tx
    .select({ isAdmin: kilocode_users.is_admin, blockedReason: kilocode_users.blocked_reason })
    .from(kilocode_users)
    .where(eq(kilocode_users.id, actorId))
    .limit(1)
    .for('share');
  if (!admin || !admin.isAdmin || admin.blockedReason !== null) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Admin access required' });
  }
}

export async function uninstallGitHubOrganizationInstallation(params: {
  input: GitHubInstallationUninstallInput;
  actor: Actor;
}): Promise<{ status: 'uninstalled'; localCleanup: 'complete' | 'pending' }> {
  let record: LocalRecord;
  try {
    record = await db.transaction(async tx => {
      await requireFreshActiveAdmin(tx, params.actor.id);
      return lockRecord(tx, params.input);
    });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw uninstallError();
  }

  try {
    await writeAudit(db, params.actor, record, 'attempted');
  } catch {
    throw uninstallError();
  }

  let upstreamDeleted = false;
  try {
    // These transaction-scoped locks auto-release, but intentionally span the bounded remote call to prevent actor revocation or target reassignment.
    await db.transaction(async tx => {
      await requireFreshActiveAdmin(tx, params.actor.id);
      const locked = await lockRecord(tx, params.input);
      await rejectEffectiveDuplicates(tx, locked);
      await verifyAndDeleteGitHubOrganizationInstallation({
        installationId: locked.installationId,
        accountId: locked.accountId,
        appType: locked.appType,
      });
      upstreamDeleted = true;
      const deleted = await tx
        .delete(platform_integrations)
        .where(
          and(
            eq(platform_integrations.id, locked.id),
            eq(platform_integrations.platform, 'github'),
            eq(platform_integrations.platform_installation_id, locked.installationId),
            eq(platform_integrations.platform_account_id, locked.accountId),
            locked.appType === 'standard'
              ? or(
                  eq(platform_integrations.github_app_type, 'standard'),
                  isNull(platform_integrations.github_app_type)
                )
              : eq(platform_integrations.github_app_type, 'lite')
          )
        );
      if ((deleted.rowCount ?? 0) !== 1) throw uninstallError();
      await writeAudit(tx, params.actor, locked, 'confirmed');
    });
    return { status: 'uninstalled', localCleanup: 'complete' };
  } catch (error) {
    if (error instanceof TRPCError && error.code === 'FORBIDDEN') throw error;
    if (upstreamDeleted) {
      await tryWriteAudit({
        actor: params.actor,
        record,
        status: 'confirmed; local cleanup pending',
      });
      return { status: 'uninstalled', localCleanup: 'pending' };
    }
    await tryWriteAudit({ actor: params.actor, record, status: 'unconfirmed' });
    throw uninstallError();
  }
}
