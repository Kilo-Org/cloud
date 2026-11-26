import { db } from '@kilocode/web-shared/lib/drizzle';
import { kilocode_users, organizations, type User } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getUserUUID } from '@kilocode/web-shared/lib/user/server';
import { isBlockedAccount } from '@kilocode/web-shared/lib/user/account-status';
import {
  recordAdminAction,
  type AdminActionTarget,
} from '@kilocode/web-shared/lib/admin/admin-action-audit';
import { getIndexStorage } from '@/lib/code-indexing/storage';

const SCRIPT = 'managed-indexing/garbage-collect';
const OPERATOR_FLAG = '--operator=';

/**
 * Garbage collection script for code indexing
 * Deletes old index data that hasn't been modified within the specified time period
 *
 * Usage:
 *   pnpm script:run managed-indexing garbage-collect <org-id-or-email> [days-or-now] --operator=<staff-email>
 *
 * Examples:
 *   pnpm script:run managed-indexing garbage-collect abc-123-def-456 --operator=me@kilocode.ai        # Delete data older than 7 days (default)
 *   pnpm script:run managed-indexing garbage-collect abc-123-def-456 30 --operator=me@kilocode.ai     # Delete data older than 30 days
 *   pnpm script:run managed-indexing garbage-collect abc-123-def-456 now --operator=me@kilocode.ai    # Delete all data
 *   pnpm script:run managed-indexing garbage-collect user@example.com --operator=me@kilocode.ai       # Delete user's data older than 7 days
 *   pnpm script:run managed-indexing garbage-collect user@example.com now --operator=me@kilocode.ai   # Delete all user's data
 *
 * This is an operator command that runs with the script's own database and
 * index credentials; it never acts as a web user and grants no web authority.
 * It deletes through the index storage primitive for exactly the one named
 * index and cutoff. `--operator` names the staff account running it: it must
 * be a current, unblocked Kilo admin, and the deletion is recorded in the admin
 * action audit log under that account with the index as its target.
 */
export async function run(...args: string[]): Promise<void> {
  const operatorArgs = args.filter(arg => arg.startsWith(OPERATOR_FLAG));
  const [orgIdOrEmail, daysOrNow = '7', ...extra] = args.filter(
    arg => !arg.startsWith(OPERATOR_FLAG)
  );
  if (!orgIdOrEmail || extra.length > 0 || operatorArgs.length !== 1) {
    throw new Error(
      `Usage: pnpm script:run ${SCRIPT.replace('/', ' ')} <org-id-or-email> [days-or-now] ${OPERATOR_FLAG}<staff-email>`
    );
  }

  console.log('🗑️  Starting garbage collection for code indexing...');
  console.log('');

  const operator = await requireOperator(operatorArgs[0].slice(OPERATOR_FLAG.length));
  console.log(`   Operator: ${operator.google_user_email} (${operator.id})`);

  let indexId: string;
  let target: AdminActionTarget;
  let scope: 'organization' | 'personal';

  if (z.uuid().safeParse(orgIdOrEmail).success) {
    const [organization] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, orgIdOrEmail))
      .limit(1);
    if (!organization) {
      throw new Error(`Organization ${orgIdOrEmail} not found`);
    }
    indexId = organization.id;
    target = { type: 'organization', id: organization.id };
    scope = 'organization';
    console.log(`   Target: Organization ${organization.id}`);
  } else {
    const [user] = await db
      .select()
      .from(kilocode_users)
      .where(eq(kilocode_users.google_user_email, orgIdOrEmail))
      .limit(1);
    if (!user) {
      throw new Error(`User with email ${orgIdOrEmail} not found`);
    }
    indexId = getUserUUID(user);
    target = { type: 'user', id: user.id };
    scope = 'personal';
    console.log(`   Target: User ${orgIdOrEmail} (${user.id})`);
  }

  let beforeDate: Date;
  if (daysOrNow.toLowerCase() === 'now') {
    beforeDate = new Date();
    console.log(`   Cutoff: NOW (deleting all data)`);
  } else {
    const days = parseInt(daysOrNow, 10);
    if (isNaN(days) || days < 0) {
      throw new Error(`Invalid days parameter: ${daysOrNow}. Must be a positive number or "now"`);
    }
    beforeDate = new Date();
    beforeDate.setDate(beforeDate.getDate() - days);
    console.log(`   Cutoff: ${days} days ago (${beforeDate.toISOString()})`);
  }

  console.log('');

  const audit = { user: operator, auditRoute: `script:${SCRIPT}` };
  const entry = {
    action: 'code_index.delete_before_date',
    target,
    message: `[Script] Deleted ${scope} code index data created before the cutoff`,
    metadata: { script: SCRIPT, scope, indexId, beforeDate: beforeDate.toISOString() },
  } as const;

  console.log('🗑️  Deleting old index data...');
  try {
    await getIndexStorage().deleteByOrganizationBeforeDate({ organizationId: indexId, beforeDate });
  } catch (error) {
    await recordAdminAction(audit, {
      ...entry,
      outcome: 'failure',
      errorCode: error instanceof Error ? error.name : 'unknown',
    });
    console.error('❌ Garbage collection failed');
    throw error;
  }
  await recordAdminAction(audit, entry);

  console.log('✅ Garbage collection completed successfully!');
  console.log('');
}

/** The staff account running this command, read from the primary database. */
async function requireOperator(email: string): Promise<User> {
  if (!email) {
    throw new Error(`${OPERATOR_FLAG} needs the email of the staff account running this command`);
  }
  const [operator] = await db
    .select()
    .from(kilocode_users)
    .where(eq(kilocode_users.google_user_email, email))
    .limit(1);
  if (!operator || !operator.is_admin || isBlockedAccount(operator)) {
    throw new Error(`Operator ${email} is not a current, unblocked Kilo admin`);
  }
  return operator;
}
