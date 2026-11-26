import { UpdateClassifierModelRequestSchema } from '@kilocode/auto-routing-contracts';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  getAutoRoutingClassifierModel,
  updateAutoRoutingClassifierModel,
} from '@kilocode/web-shared/lib/ai-gateway/auto-routing-admin-client';
import {
  addAdminAuditMetadata,
  auditedAdminRoute,
  setAdminAuditActor,
} from '@kilocode/web-shared/lib/admin/admin-action-audit';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';

export async function GET() {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  const result = await getAutoRoutingClassifierModel();
  return NextResponse.json(result.body, { status: result.status });
}

export const PUT = auditedAdminRoute(
  { kind: 'declarative', action: 'auto_routing.classifier_model.set' },
  async (request: NextRequest) => {
    const { authFailedResponse, user } = await getUserFromAuth({ adminOnly: true });
    if (authFailedResponse) return authFailedResponse;
    setAdminAuditActor(user);

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
    addAdminAuditMetadata({ model: parsed.data.model });

    const result = await updateAutoRoutingClassifierModel(parsed.data.model);
    return NextResponse.json(result.body, { status: result.status });
  }
);
