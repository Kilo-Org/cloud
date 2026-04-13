import { NextResponse } from 'next/server';
import {
  queryDiskUsage,
  type AnalyticsEngineResponse,
  type ControllerTelemetryRow,
} from '@/lib/kiloclaw/disk-usage';
import { getActiveInstance, getActiveOrgInstance } from '@/lib/kiloclaw/instance-registry';
import { getUserFromAuth } from '@/lib/user.server';

export async function GET(): Promise<
  NextResponse<{ error: string } | AnalyticsEngineResponse<ControllerTelemetryRow>>
> {
  const { user, authFailedResponse, organizationId } = await getUserFromAuth({
    adminOnly: false,
  });
  if (authFailedResponse) return authFailedResponse;

  try {
    const instance = organizationId
      ? await getActiveOrgInstance(user.id, organizationId)
      : await getActiveInstance(user.id);

    if (organizationId && !instance) {
      return NextResponse.json(
        { error: 'No active instance for this organization' },
        { status: 404 }
      );
    }

    if (!instance) {
      return NextResponse.json({ error: 'No active instance' }, { status: 404 });
    }

    const result = await queryDiskUsage(instance.sandboxId);
    return NextResponse.json(result);
  } catch (error) {
    console.error('[api/kiloclaw/disk-usage] error:', error);
    return NextResponse.json({ error: 'Failed to query disk usage' }, { status: 502 });
  }
}
