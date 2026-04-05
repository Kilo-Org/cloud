import { createCallerFactory } from '@/lib/trpc/init';
import { rootRouter } from '@/routers/root-router';
import { db } from '@/lib/drizzle';
import { kilocode_users } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

const createCaller = createCallerFactory(rootRouter);

/**
 * Garbage collection script for code indexing
 * Deletes old index data that hasn't been modified within the specified time period
 *
 * Usage:
 *   pnpm script:run managed-indexing garbage-collect <org-id-or-email> [days-or-now]
 *
 * Examples:
 *   pnpm script:run managed-indexing garbage-collect abc-123-def-456        # Delete data older than 7 days (default)
 *   pnpm script:run managed-indexing garbage-collect abc-123-def-456 30     # Delete data older than 30 days
 *   pnpm script:run managed-indexing garbage-collect abc-123-def-456 now    # Delete all data
 *   pnpm script:run managed-indexing garbage-collect user@example.com       # Delete user's data older than 7 days
 *   pnpm script:run managed-indexing garbage-collect user@example.com now   # Delete all user's data
 */
export async function run(orgIdOrEmail: string, daysOrNow: string = '7'): Promise<void> {
  console.log('🗑️  Starting garbage collection for code indexing...');
  console.log('');

  // Determine if this is an organization ID or user email
  let organizationId: string | null = null;
  let userId: string | null = null;

  if (z.uuid().safeParse(orgIdOrEmail).success) {
    organizationId = orgIdOrEmail;
    console.log(`   Target: Organization ${organizationId}`);
  } else {
    // Look up user by email
    const user = await db
      .select()
      .from(kilocode_users)
      .where(eq(kilocode_users.google_user_email, orgIdOrEmail))
      .limit(1);

    if (!user || user.length === 0) {
      throw new Error(`User with email ${orgIdOrEmail} not found`);
    }

    userId = user[0].id;
    console.log(`   Target: User ${orgIdOrEmail} (${userId})`);
  }

  // Calculate the cutoff date
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

  // Create tRPC context and caller
  // We need a user context, so we'll use the target user if it's a user operation,
  // or fetch an admin user for organization operations
  let contextUser;
  if (userId) {
    const user = await db
      .select()
      .from(kilocode_users)
      .where(eq(kilocode_users.id, userId))
      .limit(1);
    contextUser = user[0];
  } else {
    // For organization operations, we need any admin user to create the context
    const adminUser = await db
      .select()
      .from(kilocode_users)
      .where(eq(kilocode_users.is_admin, true))
      .limit(1);

    if (!adminUser || adminUser.length === 0) {
      throw new Error('No admin user found to create tRPC context');
    }
    contextUser = adminUser[0];
  }

  const caller = createCaller({
    user: contextUser,
  });

  // Call the deleteBeforeDate procedure
  console.log('🗑️  Deleting old index data...');
  const result = await caller.codeIndexing.deleteBeforeDate({
    organizationId: organizationId || undefined,
    beforeDate,
  });

  if (result.success) {
    console.log('✅ Garbage collection completed successfully!');
  } else {
    console.error('❌ Garbage collection failed');
    process.exit(1);
  }

  console.log('');
}
