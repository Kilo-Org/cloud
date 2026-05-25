import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { insertKiloClawSubscriptionChangeLog } from '@kilocode/db';
import { ImpactReferralPaymentProvider } from '@kilocode/db/schema-types';

import { db } from '@/lib/drizzle';
import { resolveCurrentPersonalSubscriptionRow } from '@/lib/kiloclaw/current-personal-subscription';
import { processPersonalKiloClawPaidConversion } from '@/lib/impact/kiloclaw-referrals';
import { getUserFromAuth } from '@/lib/user/server';

const OverrideBodySchema = z.object({
  sourcePaymentId: z.string().min(1),
  orderId: z.string().min(1),
  amount: z.number().nonnegative(),
  currencyCode: z.string().min(1),
  itemCategory: z.string().min(1),
  itemName: z.string().min(1),
  itemSku: z.string().min(1).optional(),
  paymentProvider: z
    .enum([ImpactReferralPaymentProvider.Credits, ImpactReferralPaymentProvider.Stripe])
    .optional(),
  convertedAt: z.string().datetime(),
  sourceType: z.enum(['test', 'fraudulent', 'admin_created', 'manual_adjustment']),
});

function derivePaymentProvider(sourcePaymentId: string): ImpactReferralPaymentProvider {
  return sourcePaymentId.startsWith('in_') ||
    sourcePaymentId.startsWith('pi_') ||
    sourcePaymentId.startsWith('ch_')
    ? ImpactReferralPaymentProvider.Stripe
    : ImpactReferralPaymentProvider.Credits;
}

/**
 * Admin-only support route for explicitly marking an otherwise excluded
 * KiloClaw referral conversion as eligible.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { user: adminUser, authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) {
    return authFailedResponse;
  }

  if (!adminUser) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = OverrideBodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  const userId = (await params).id;
  const currentPersonalSubscription = await resolveCurrentPersonalSubscriptionRow({
    userId,
    dbOrTx: db,
  });
  if (!currentPersonalSubscription) {
    return NextResponse.json(
      { error: 'No current personal KiloClaw subscription found for referral override' },
      { status: 409 }
    );
  }

  await insertKiloClawSubscriptionChangeLog(db, {
    subscriptionId: currentPersonalSubscription.subscription.id,
    actor: {
      actorType: 'user',
      actorId: adminUser.id,
    },
    action: 'admin_override',
    reason: `referral_eligibility_override:${body.data.sourceType}:${body.data.sourcePaymentId}`,
    before: currentPersonalSubscription.subscription,
    after: currentPersonalSubscription.subscription,
  });

  const disposition = await processPersonalKiloClawPaidConversion({
    userId,
    sourcePaymentId: body.data.sourcePaymentId,
    orderId: body.data.orderId,
    paymentProvider: body.data.paymentProvider ?? derivePaymentProvider(body.data.sourcePaymentId),
    amount: body.data.amount,
    currencyCode: body.data.currencyCode,
    itemCategory: body.data.itemCategory,
    itemName: body.data.itemName,
    itemSku: body.data.itemSku,
    convertedAt: new Date(body.data.convertedAt),
    qualificationContext: {
      sourceType: body.data.sourceType,
      overrideEligible: true,
    },
  });

  return NextResponse.json({
    ok: true,
    disposition,
  });
}
