import { NextResponse } from 'next/server';
import { authorizeInternalApiRequest } from '@/lib/internal-api-auth';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { getGrantedClaudeBillingConnection } from '@kilocode/web-shared/lib/ai-gateway/claude-billing/store';
import {
  ClaudeBillingPayerOwnerSchema,
  claudeBillingPayerState,
} from '@kilocode/web-shared/lib/ai-gateway/claude-billing/payer-state';

// The web app runs only in Frankfurt, next to the primary database.
export async function POST(request: Request) {
  const unauthorized = authorizeInternalApiRequest(request);
  if (unauthorized) return unauthorized;
  const owner = ClaudeBillingPayerOwnerSchema.safeParse(await request.json().catch(() => null));
  if (!owner.success) return NextResponse.json({ error: 'Invalid owner' }, { status: 400 });
  const row = await getGrantedClaudeBillingConnection(owner.data, db);
  return NextResponse.json(
    { connection: claudeBillingPayerState(row) },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
