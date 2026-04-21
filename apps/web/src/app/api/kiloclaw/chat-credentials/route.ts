import { NextResponse } from 'next/server';
import { TRPCError } from '@trpc/server';
import { getUserFromAuth } from '@/lib/user.server';
import { KiloClawUserClient } from '@/lib/kiloclaw/kiloclaw-user-client';
import { KiloClawApiError } from '@/lib/kiloclaw/kiloclaw-internal-client';
import { generateApiToken, TOKEN_EXPIRY } from '@/lib/tokens';
import { requireKiloClawAccessAtInstance } from '@/lib/kiloclaw/access-gate';
import {
  getActiveInstance,
  getActiveOrgInstance,
  workerInstanceId,
} from '@/lib/kiloclaw/instance-registry';

export async function GET() {
  const { user, authFailedResponse, organizationId } = await getUserFromAuth({
    adminOnly: false,
  });
  if (authFailedResponse) return authFailedResponse;

  // Personal-only billing gate — org access is gated at org membership level
  // (validated by getUserFromAuth). Matches tRPC org router's
  // getStreamChatCredentials which uses organizationMemberProcedure (no billing gate).
  if (!organizationId) {
    const instance = await getActiveInstance(user.id);
    if (!instance) {
      return NextResponse.json({ error: 'No active KiloClaw instance found' }, { status: 404 });
    }

    try {
      await requireKiloClawAccessAtInstance(user.id, instance.id);
    } catch (err) {
      if (err instanceof TRPCError && err.code === 'NOT_FOUND') {
        return NextResponse.json({ error: err.message }, { status: 404 });
      }
      if (err instanceof TRPCError && err.code === 'FORBIDDEN') {
        return NextResponse.json({ error: err.message }, { status: 403 });
      }
      throw err;
    }
  }

  try {
    const instance = organizationId
      ? await getActiveOrgInstance(user.id, organizationId)
      : await getActiveInstance(user.id);

    // No org instance → 404. Without this guard workerInstanceId(null)
    // → undefined → the worker queries the personal DO, leaking personal
    // credentials into the org context.
    if (organizationId && !instance) {
      return NextResponse.json(
        { error: 'No active instance for this organization' },
        { status: 404 }
      );
    }

    const token = generateApiToken(user, undefined, {
      expiresIn: TOKEN_EXPIRY.fiveMinutes,
    });
    const client = new KiloClawUserClient(token);
    const creds = await client.getChatCredentials({
      userId: user.id,
      instanceId: workerInstanceId(instance),
    });
    return NextResponse.json(creds);
  } catch (err) {
    const status = err instanceof KiloClawApiError ? err.statusCode : 502;
    console.error('[api/kiloclaw/chat-credentials] error:', err);
    return NextResponse.json({ error: 'KiloClaw request failed' }, { status });
  }
}
