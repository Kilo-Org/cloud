import { NextResponse } from 'next/server';
import { and, eq, isNull, sql } from 'drizzle-orm';

import { db } from '@/lib/drizzle';
import { CRON_SECRET } from '@/lib/config.server';
import { kilocode_users, organizations } from '@kilocode/db/schema';
import { restoreSalesDemoOrganization } from '@/lib/organizations/sales-demo';

if (!CRON_SECRET) {
  throw new Error('CRON_SECRET is not configured in environment variables');
}

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  const expectedAuth = `Bearer ${CRON_SECRET}`;
  if (authHeader !== expectedAuth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const demoOrgs = await db
    .select({
      id: organizations.id,
      created_by_kilo_user_id: organizations.created_by_kilo_user_id,
    })
    .from(organizations)
    .where(
      and(
        sql`${organizations.settings}->>'is_sales_demo' = 'true'`,
        isNull(organizations.deleted_at)
      )
    );

  let reset = 0;
  let failed = 0;

  for (const org of demoOrgs) {
    try {
      const owner = org.created_by_kilo_user_id
        ? await db.query.kilocode_users.findFirst({
            where: eq(kilocode_users.id, org.created_by_kilo_user_id),
          })
        : null;

      if (!owner) {
        failed++;
        continue;
      }

      await db.transaction(async tx => {
        await restoreSalesDemoOrganization({
          organizationId: org.id,
          actorUser: owner,
          txn: tx,
        });
      });
      reset++;
    } catch {
      failed++;
    }
  }

  return NextResponse.json({ reset, failed });
}
