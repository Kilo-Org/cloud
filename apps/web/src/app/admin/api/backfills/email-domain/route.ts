import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { db } from '@/lib/drizzle';
import { kilocode_users } from '@kilocode/db';
import { and, isNull, count, not, or, sql, like } from 'drizzle-orm';
import { extractEmailDomain } from '@/lib/email-domain';

// Exclude soft-deleted users: softDeleteUser anonymizes them to
// `deleted+<id>@deleted.invalid` and sets `blocked_reason` to a string starting
// with `soft-deleted at`. Filling email_domain for those rows would undo the
// GDPR nulling invariant.
export const emailDomainBackfillCandidates = and(
  isNull(kilocode_users.email_domain),
  or(
    isNull(kilocode_users.blocked_reason),
    not(like(kilocode_users.blocked_reason, 'soft-deleted at %'))
  )
);

export type EmailDomainCountsResponse = {
  missing: number;
};

export type EmailDomainBackfillResponse = {
  processed: number;
  remaining: boolean;
};

export async function GET(): Promise<NextResponse<EmailDomainCountsResponse | { error: string }>> {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  const [result] = await db
    .select({ count: count() })
    .from(kilocode_users)
    .where(emailDomainBackfillCandidates);

  return NextResponse.json({ missing: result?.count ?? 0 });
}

const BATCH_SIZE = 1000;
const BATCHES_PER_REQUEST = 50;

export async function POST(): Promise<
  NextResponse<EmailDomainBackfillResponse | { error: string }>
> {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  let totalProcessed = 0;

  for (let i = 0; i < BATCHES_PER_REQUEST; i++) {
    const rows = await db
      .select({ id: kilocode_users.id, google_user_email: kilocode_users.google_user_email })
      .from(kilocode_users)
      .where(emailDomainBackfillCandidates)
      .limit(BATCH_SIZE);

    if (rows.length === 0) break;

    const updates = rows
      .map(row => ({
        id: row.id,
        email_domain: extractEmailDomain(row.google_user_email),
      }))
      .filter((u): u is { id: string; email_domain: string } => u.email_domain !== null);

    if (updates.length === 0) break;

    await db.execute(sql`
      UPDATE ${kilocode_users}
      SET email_domain = domain_updates.email_domain
      FROM (VALUES ${sql.join(
        updates.map(u => sql`(${u.id}, ${u.email_domain})`),
        sql`, `
      )}) AS domain_updates(id, email_domain)
      WHERE ${kilocode_users.id} = domain_updates.id
    `);

    totalProcessed += updates.length;

    if (rows.length < BATCH_SIZE) break;
  }

  return NextResponse.json({
    processed: totalProcessed,
    remaining: totalProcessed === BATCH_SIZE * BATCHES_PER_REQUEST,
  });
}
