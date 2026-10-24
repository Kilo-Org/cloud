import { after, NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { organizations } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { sendOrganizationLowBalanceAlert } from '@kilocode/web-shared/lib/organizations/organization-usage';
import { toMicrodollars } from '@kilocode/web-shared/lib/microdollars';
import { authorizeInternalApiRequest } from '@/lib/internal-api-auth';

const bodySchema = z.object({ organizationId: z.uuid() }).strict();

export async function POST(request: NextRequest) {
  const unauthorized = authorizeInternalApiRequest(request);
  if (unauthorized) return unauthorized;
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  const [organization] = await db
    .select({ settings: organizations.settings })
    .from(organizations)
    .where(eq(organizations.id, body.data.organizationId))
    .limit(1);
  const minimum = organization?.settings?.minimum_balance;
  if (minimum) {
    after(() =>
      sendOrganizationLowBalanceAlert(
        body.data.organizationId,
        toMicrodollars(minimum),
        organization.settings?.minimum_balance_alert_email ?? []
      )
    );
  }
  return NextResponse.json({ ok: true });
}
