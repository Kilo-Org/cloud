import { and, eq, inArray, sql } from 'drizzle-orm';
import { kilocode_users, user_deletion_requests, type User } from '@kilocode/db/schema';
import { isSoftDeletedBlockedReason } from '@kilocode/db/user-soft-delete';
import { db } from '@/lib/drizzle';
import { assertNoLiveSubscriptionsForSoftDelete, SoftDeletePreconditionError } from '@/lib/user';
import { hmacDeletionEmail } from '@/lib/user/deletion-queue/deletion-hmac';
import {
  classifyProtectedIdentity,
  DeletionRefusalCode,
  type DeletionActorIdentity,
  previewDeletionTargets,
  type DeletionPreviewAccepted,
  type DeletionPreviewEntry,
  type DeletionPreviewRejected,
  type DeletionRefusalCode as RefusalCode,
} from '@/lib/user/deletion-queue/deletion-intake';
import { ACTIVE_REQUEST_STATUSES } from '@/lib/user/deletion-queue/deletion-types';

export const DeletionInspectWarning = {
  KiloPassActive: 'kilo_pass_active',
  KiloclawSubscriptionActive: 'kiloclaw_subscription_active',
  ResolvesAtPreflight: 'resolves_at_preflight',
} as const;

export type DeletionInspectAccepted = {
  ok: true;
  email: string;
  pylonTicket: string | null;
  warnings: string[];
  userId: string | null;
};

export type DeletionInspectResult = {
  accepted: DeletionInspectAccepted[];
  rejected: DeletionPreviewRejected[];
};

export async function inspectDeletionTargets(
  entries: DeletionPreviewEntry[],
  actor?: DeletionActorIdentity | null
): Promise<DeletionInspectResult> {
  const local = previewDeletionTargets(entries);
  if (local.accepted.length === 0) {
    return { accepted: [], rejected: local.rejected };
  }

  const accepted: DeletionInspectAccepted[] = [];
  const rejected: DeletionPreviewRejected[] = [...local.rejected];
  const seenEmails = new Set<string>();

  for (const target of local.accepted) {
    if (!target.email) {
      const inspected = await inspectTicketOnlyTarget(target);
      if (inspected.ok) {
        accepted.push(inspected);
      } else {
        rejected.push(inspected);
      }
      continue;
    }
    if (seenEmails.has(target.email)) {
      rejected.push(rejectTarget(target, DeletionRefusalCode.DuplicateEntry));
      continue;
    }
    seenEmails.add(target.email);
    const inspected = await inspectOneTarget(target, actor);
    if (inspected.ok) {
      accepted.push(inspected);
    } else {
      rejected.push(inspected);
    }
  }

  return { accepted, rejected };
}

async function inspectTicketOnlyTarget(
  target: DeletionPreviewAccepted
): Promise<DeletionInspectAccepted | DeletionPreviewRejected> {
  if (!target.pylonTicket) {
    return rejectTarget(target, DeletionRefusalCode.MalformedEmail);
  }
  const byTicket = await findActiveRequestByPylonTicket(target.pylonTicket);
  if (byTicket) {
    return rejectTarget(target, DeletionRefusalCode.TicketAlreadyActive);
  }
  return {
    ok: true,
    email: '',
    pylonTicket: target.pylonTicket,
    warnings: [DeletionInspectWarning.ResolvesAtPreflight],
    userId: null,
  };
}

async function inspectOneTarget(
  target: DeletionPreviewAccepted,
  actor?: DeletionActorIdentity | null
): Promise<DeletionInspectAccepted | DeletionPreviewRejected> {
  const users = await loadCurrentUsersByEmail(target.email);
  if (users.length > 1) {
    return rejectTarget(target, DeletionRefusalCode.AmbiguousCloudIdentity);
  }

  const user = users[0] ?? null;
  const protectedCode = classifyProtectedIdentity({ email: target.email, user, actor });
  if (protectedCode) {
    return rejectTarget(target, protectedCode);
  }

  const active = await findActiveRequestByEmailHmac(target.email);
  if (active) {
    return rejectTarget(target, DeletionRefusalCode.AlreadyActive);
  }
  if (target.pylonTicket) {
    const byTicket = await findActiveRequestByPylonTicket(target.pylonTicket);
    if (byTicket) {
      return rejectTarget(target, DeletionRefusalCode.TicketAlreadyActive);
    }
  }

  const warnings: string[] = [];
  if (user) {
    try {
      await assertNoLiveSubscriptionsForSoftDelete(user.id, db);
    } catch (error) {
      if (error instanceof SoftDeletePreconditionError) {
        warnings.push(
          error.message.includes('Kilo Pass')
            ? DeletionInspectWarning.KiloPassActive
            : DeletionInspectWarning.KiloclawSubscriptionActive
        );
      } else {
        throw error;
      }
    }
  }

  return {
    ok: true,
    email: target.email,
    pylonTicket: target.pylonTicket,
    warnings,
    userId: user?.id ?? null,
  };
}

function rejectTarget(target: DeletionPreviewAccepted, code: RefusalCode): DeletionPreviewRejected {
  return {
    ok: false,
    email: target.email,
    pylonTicket: target.pylonTicket,
    code,
  };
}

async function loadCurrentUsersByEmail(email: string): Promise<User[]> {
  const users = await db
    .select()
    .from(kilocode_users)
    .where(eq(sql`lower(${kilocode_users.google_user_email})`, email));
  return users.filter(user => !isSoftDeletedBlockedReason(user.blocked_reason));
}

async function findActiveRequestByPylonTicket(ticket: string) {
  const normalized = ticket.replace(/^#/, '');
  const [row] = await db
    .select({ id: user_deletion_requests.id })
    .from(user_deletion_requests)
    .where(
      and(
        eq(sql`regexp_replace(${user_deletion_requests.pylon_ticket_ref}, '^#', '')`, normalized),
        inArray(user_deletion_requests.status, ACTIVE_REQUEST_STATUSES)
      )
    )
    .limit(1);
  return row ?? null;
}

async function findActiveRequestByEmailHmac(email: string) {
  const hmac = hmacDeletionEmail(email);
  const [row] = await db
    .select({ id: user_deletion_requests.id })
    .from(user_deletion_requests)
    .where(
      and(
        eq(user_deletion_requests.target_email_hmac, hmac),
        inArray(user_deletion_requests.status, ACTIVE_REQUEST_STATUSES)
      )
    )
    .limit(1);
  return row ?? null;
}
