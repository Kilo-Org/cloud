import { sql } from 'drizzle-orm';

const MAX_EMAIL_ATTEMPTS = 4;

type Execute = (query: ReturnType<typeof sql>) => Promise<{ rows: Array<{ id: string }> }>;

export async function markDelivery(
  execute: Execute,
  exportId: string,
  leaseToken: string,
  status: 'pending' | 'sent' | 'failed'
): Promise<boolean> {
  const result = await execute(sql`
    UPDATE user_data_exports
    SET email_status = ${status},
      email_lease_token = NULL,
      email_lease_expires_at = NULL,
      email_sent_at = CASE WHEN ${status} = 'sent' THEN now() ELSE email_sent_at END,
      updated_at = now()
    WHERE id = ${exportId} AND email_status = 'sending' AND email_lease_token = ${leaseToken}
    RETURNING id
  `);
  return result.rows.length > 0;
}

export async function markRetryableDelivery(
  execute: Execute,
  exportId: string,
  leaseToken: string
): Promise<boolean> {
  const result = await execute(sql`
    UPDATE user_data_exports
    SET email_status = CASE WHEN email_attempt_count >= ${MAX_EMAIL_ATTEMPTS} THEN 'failed' ELSE 'pending' END,
      email_lease_token = NULL,
      email_lease_expires_at = NULL,
      updated_at = now()
    WHERE id = ${exportId} AND email_status = 'sending' AND email_lease_token = ${leaseToken}
    RETURNING id
  `);
  return result.rows.length > 0;
}
