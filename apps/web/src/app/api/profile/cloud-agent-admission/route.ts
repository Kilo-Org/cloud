import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { captureException } from '@sentry/nextjs';
import * as z from 'zod';
import { db } from '@/lib/drizzle';
import { getUserFromAuth } from '@/lib/user/server';
import { getBalanceAndOrgSettings } from '@/lib/organizations/organization-usage';
import {
  classifyCloudAgentModelBilling,
  type CloudAgentModelBilling,
} from '@/lib/cloud-agent-next/classify-model-billing';

const BodySchema = z.object({ modelId: z.string().trim().min(1) });

type AdmissionResult = {
  classification: CloudAgentModelBilling;
  /** Owner balance, only resolved when the model is `balance-required`; `null` otherwise. */
  balance: number | null;
  isDepleted: boolean | null;
};

type AdmissionResponse = { error: string } | AdmissionResult;

/**
 * Single admission check for a Cloud Agent mutation: classifies how the model
 * would be billed and, when it is `balance-required`, resolves the owner's
 * balance in the same round-trip. Backs the worker's balance middleware, which
 * cannot import the model catalog or read balance directly.
 *
 * The organization owner comes from the `X-KiloCode-OrganizationId` header
 * (membership validated by `getUserFromAuth`); otherwise the caller's user is
 * the owner. Balance is only computed when needed, so `free`/`byok` sessions
 * pay no extra cost.
 */
export async function POST(request: NextRequest): Promise<NextResponse<AdmissionResponse>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const bodyResult = BodySchema.safeParse(body);
  if (!bodyResult.success) {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { user, authFailedResponse, organizationId } = await getUserFromAuth({ adminOnly: false });
  if (authFailedResponse) return authFailedResponse;

  try {
    const classification = await classifyCloudAgentModelBilling({
      fromDb: db,
      modelId: bodyResult.data.modelId,
      userId: user.id,
      organizationId,
    });

    if (classification !== 'balance-required') {
      return NextResponse.json({ classification, balance: null, isDepleted: null });
    }

    const { balance } = await getBalanceAndOrgSettings(organizationId, user);
    return NextResponse.json({ classification, balance, isDepleted: balance <= 0 });
  } catch (error) {
    captureException(error, {
      tags: { endpoint: 'profile/cloud-agent-admission' },
      extra: { userId: user.id, organizationId, modelId: bodyResult.data.modelId },
    });
    return NextResponse.json({ error: 'Failed to check cloud agent admission' }, { status: 500 });
  }
}
