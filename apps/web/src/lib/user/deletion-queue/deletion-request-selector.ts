import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { user_deletion_requests } from '@kilocode/db/schema';
import { UserDeletionRequestStatus } from '@kilocode/db/schema-types';
import { db } from '@/lib/drizzle';

export type SelectedDeletionRequest = {
  id: string;
  status: UserDeletionRequestStatus;
};

export async function selectEligibleDeletionRequest(params: {
  excludeRequestIds?: readonly string[];
}): Promise<SelectedDeletionRequest | null> {
  const exclude = params.excludeRequestIds ?? [];
  const [row] = await db
    .select({
      id: user_deletion_requests.id,
      status: user_deletion_requests.status,
    })
    .from(user_deletion_requests)
    .where(
      and(
        or(
          and(
            eq(user_deletion_requests.status, UserDeletionRequestStatus.Pending),
            isNull(user_deletion_requests.preflight_attention_code)
          ),
          and(
            inArray(user_deletion_requests.status, [
              UserDeletionRequestStatus.InProgress,
              UserDeletionRequestStatus.Finalizing,
            ]),
            sql`EXISTS (
              SELECT 1 FROM user_deletion_steps s
              WHERE s.request_id = ${user_deletion_requests.id}
                AND s.status IN ('pending', 'retry_wait', 'running')
                AND s.available_at <= now()
            )`
          )
        ),
        exclude.length > 0
          ? sql`${user_deletion_requests.id} NOT IN (${sql.join(
              exclude.map(id => sql`${id}::uuid`),
              sql`, `
            )})`
          : sql`true`
      )
    )
    .orderBy(
      asc(user_deletion_requests.last_progress_at),
      asc(user_deletion_requests.created_at),
      asc(user_deletion_requests.id)
    )
    .limit(1);

  return row ?? null;
}
