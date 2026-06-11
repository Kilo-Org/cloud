import { UpdateClassifierModelRequestSchema } from '@kilocode/auto-routing-contracts';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  getAutoRoutingClassifierModel,
  updateAutoRoutingClassifierModel,
} from '@/lib/ai-gateway/auto-routing-admin-client';
import { getUserFromAuth } from '@/lib/user/server';

export async function GET() {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  const result = await getAutoRoutingClassifierModel();
  return NextResponse.json(result.body, { status: result.status });
}

export async function PUT(request: NextRequest) {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = UpdateClassifierModelRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid classifier model' }, { status: 400 });
  }

  const result = await updateAutoRoutingClassifierModel(parsed.data.model);
  return NextResponse.json(result.body, { status: result.status });
}
