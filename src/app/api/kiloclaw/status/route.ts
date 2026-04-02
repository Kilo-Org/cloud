import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { KiloClawUserClient } from '@/lib/kiloclaw/kiloclaw-user-client';
import { KiloClawApiError } from '@/lib/kiloclaw/kiloclaw-internal-client';
import { generateApiToken, TOKEN_EXPIRY } from '@/lib/tokens';
import { getActiveInstance, workerInstanceId } from '@/lib/kiloclaw/instance-registry';

export async function GET() {
  const { user, authFailedResponse } = await getUserFromAuth({
    adminOnly: false,
  });
  if (authFailedResponse) return authFailedResponse;

  try {
    const instance = await getActiveInstance(user.id);
    const token = generateApiToken(user, undefined, {
      expiresIn: TOKEN_EXPIRY.fiveMinutes,
    });
    const client = new KiloClawUserClient(token);
    const status = await client.getStatus({
      userId: user.id,
      instanceId: workerInstanceId(instance),
    });
    return NextResponse.json(status);
  } catch (err) {
    const status = err instanceof KiloClawApiError ? err.statusCode : 502;
    console.error('[api/kiloclaw/status] error:', err);
    return NextResponse.json({ error: 'KiloClaw request failed' }, { status });
  }
}
