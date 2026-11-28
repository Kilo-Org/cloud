import { NextResponse } from 'next/server';
import { authorizeInternalRouteRequest } from '@/lib/internal-api-auth';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  claudeBillingEffectiveConnection,
  getGrantedClaudeBillingConnection,
} from '@kilocode/web-shared/lib/ai-gateway/claude-billing/store';
import {
  ClaudeBillingOwnerSchema,
  claudeBillingPayerState,
} from '@kilocode/web-shared/lib/ai-gateway/claude-billing/payer-state';

// The web app runs only in Frankfurt, next to the primary database.
export async function POST(request: Request) {
  const auth = await authorizeInternalRouteRequest(
    request,
    'claude_billing_payer_state',
    'claude_billing_payer_state'
  );
  if (auth instanceof Response) return auth;
  const owner = ClaudeBillingOwnerSchema.safeParse(await request.json().catch(() => null));
  if (!owner.success) return NextResponse.json({ error: 'Invalid owner' }, { status: 400 });
  const granted = await getGrantedClaudeBillingConnection(owner.data, db);
  return NextResponse.json(
    {
      connection: claudeBillingPayerState(
        granted ? claudeBillingEffectiveConnection(granted) : null
      ),
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
