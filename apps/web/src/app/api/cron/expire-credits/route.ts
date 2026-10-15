import { NextResponse } from 'next/server';
import { kilocode_users, organizations } from '@kilocode/db/schema';
import { asc, lte } from 'drizzle-orm';
import { captureException } from '@sentry/nextjs';
import { CRON_SECRET } from '@kilocode/web-shared/lib/config.server';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  processLocalExpirations,
  processOrganizationExpirationsBatch,
} from '@kilocode/web-shared/lib/creditExpiration';
import {
  buildScheduledJobFailureEvent,
  buildScheduledJobSuccessEvent,
  createScheduledJobRun,
  emitScheduledJobEvent,
} from '@kilocode/worker-utils/scheduled-job-observability';

const BATCH_SIZE = 100;
const MAX_BATCHES_PER_RUN = 2;

export const maxDuration = 300;

export async function GET(request: Request) {
  if (!CRON_SECRET || request.headers.get('authorization') !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const run = createScheduledJobRun({
    jobName: 'web.expire_credits',
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
  });

  try {
    const now = new Date();
    const cutoffDate = now.toISOString();
    let usersProcessed = 0;
    let organizationsProcessed = 0;
    let usersFailed = 0;
    let batchesRun = 0;
    let hasMoreUsers = true;
    let hasMoreOrganizations = true;

    for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch++) {
      if (hasMoreUsers) {
        const users = await db
          .select({
            id: kilocode_users.id,
            microdollars_used: kilocode_users.microdollars_used,
            total_microdollars_acquired: kilocode_users.total_microdollars_acquired,
            next_credit_expiration_at: kilocode_users.next_credit_expiration_at,
            updated_at: kilocode_users.updated_at,
          })
          .from(kilocode_users)
          .where(lte(kilocode_users.next_credit_expiration_at, cutoffDate))
          .orderBy(asc(kilocode_users.next_credit_expiration_at), asc(kilocode_users.id))
          .limit(BATCH_SIZE + 1);
        for (const user of users.slice(0, BATCH_SIZE)) {
          try {
            await processLocalExpirations(user, now);
            usersProcessed++;
          } catch (error) {
            usersFailed++;
            captureException(error, {
              tags: { source: 'expire_credits_cron' },
              extra: { kilo_user_id: user.id },
            });
          }
        }
        hasMoreUsers = users.length > BATCH_SIZE;
      }

      if (hasMoreOrganizations) {
        const orgs = await db
          .select({
            id: organizations.id,
            microdollars_used: organizations.microdollars_used,
            total_microdollars_acquired: organizations.total_microdollars_acquired,
            next_credit_expiration_at: organizations.next_credit_expiration_at,
          })
          .from(organizations)
          .where(lte(organizations.next_credit_expiration_at, cutoffDate))
          .orderBy(asc(organizations.next_credit_expiration_at), asc(organizations.id))
          .limit(BATCH_SIZE + 1);
        const owners = orgs.slice(0, BATCH_SIZE);
        if (owners.length > 0) {
          await processOrganizationExpirationsBatch(owners, now);
          organizationsProcessed += owners.length;
        }
        hasMoreOrganizations = orgs.length > BATCH_SIZE;
      }

      batchesRun++;
      if (!hasMoreUsers && !hasMoreOrganizations) break;
    }

    const result = {
      usersProcessed,
      usersFailed,
      organizationsProcessed,
      batchSize: BATCH_SIZE,
      batchesRun,
      hasMore: hasMoreUsers || hasMoreOrganizations,
      cutoffDate,
    };
    if (usersFailed > 0) {
      emitScheduledJobEvent(
        buildScheduledJobFailureEvent(run, new Error(`${usersFailed} user expirations failed`))
      );
      return NextResponse.json(result, { status: 500 });
    }
    emitScheduledJobEvent(buildScheduledJobSuccessEvent(run, result));
    return NextResponse.json(result);
  } catch (error) {
    emitScheduledJobEvent(buildScheduledJobFailureEvent(run, error));
    throw error;
  }
}
