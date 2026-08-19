import { user_deletion_activity, user_deletion_audit_events } from '@kilocode/db/schema';
import {
  type UserDeletionAuditEventType,
  type UserDeletionStepKey,
  type UserDeletionActivityDetails,
  type UserDeletionAuditDetails,
} from '@kilocode/db/schema-types';
import type { DrizzleTransaction } from '@/lib/drizzle';

export type AuditWrite = {
  requestId?: string | null;
  eventType: UserDeletionAuditEventType;
  actorKiloUserId?: string | null;
  targetEmailHmac: string;
  subjectKey: string;
  details?: UserDeletionAuditDetails;
};

export type ActivityWrite = {
  requestId: string;
  stepKey?: UserDeletionStepKey | null;
  eventType: string;
  details?: UserDeletionActivityDetails;
};

export async function writeDeletionAudit(tx: DrizzleTransaction, event: AuditWrite): Promise<void> {
  await tx
    .insert(user_deletion_audit_events)
    .values({
      request_id: event.requestId ?? null,
      event_type: event.eventType,
      actor_kilo_user_id: event.actorKiloUserId ?? null,
      target_email_hmac: event.targetEmailHmac,
      subject_key: event.subjectKey,
      details_json: event.details ?? {},
    })
    .onConflictDoNothing();
}

export async function writeDeletionActivity(
  tx: DrizzleTransaction,
  event: ActivityWrite
): Promise<void> {
  await tx.insert(user_deletion_activity).values({
    request_id: event.requestId,
    step_key: event.stepKey ?? null,
    event_type: event.eventType,
    details_json: event.details ?? {},
  });
}
