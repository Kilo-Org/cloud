import 'server-only';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getUserFromSessionForCredentialIssuance } from '@kilocode/web-shared/lib/user/server';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { NEXTAUTH_SECRET } from '@kilocode/web-shared/lib/config.server';
import { isOrganizationMember } from '@kilocode/worker-utils/account-access';
import { signModernKiloToken } from '@kilocode/worker-utils/kilo-token-policy';
import { KILO_API_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';
import { readBoundedStream } from '@kilocode/worker-utils/bounded-stream-reader';
import { SESSION_SYNC_WORKER_URL } from '@/lib/web-config.server';

const inputSchema = z.object({ organizationId: z.string().uuid().optional() });
const grantSchema = z.object({
  version: z.literal(1),
  token: z.string().min(1),
  expiresAt: z.iso.datetime(),
  userID: z.string().min(1),
  tenant: z.object({ type: z.enum(['user', 'organization']), id: z.string().min(1) }),
});
const headers = { 'Cache-Control': 'no-store' };
const failure = (status: number, error: string) =>
  NextResponse.json({ error }, { status, headers });

export async function POST(request: Request) {
  try {
    const { user, authFailedResponse } = await getUserFromSessionForCredentialIssuance();
    if (authFailedResponse || !user) return failure(401, 'Unauthorized');
    const body = request.body ? await readBoundedStream(request.body, 1024) : undefined;
    if (!body?.ok) return failure(400, 'Invalid request');
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder().decode(body.bytes));
    } catch {
      return failure(400, 'Invalid request');
    }
    const input = inputSchema.safeParse(json);
    if (!input.success) return failure(400, 'Invalid request');
    const { organizationId } = input.data;
    if (organizationId && !(await isOrganizationMember(db, organizationId, user.id)))
      return failure(403, 'Organization access denied');
    if (!SESSION_SYNC_WORKER_URL || !NEXTAUTH_SECRET)
      return failure(503, 'Session sync authorization is unavailable');
    const credential = await signModernKiloToken({
      userId: user.id,
      pepper: user.api_token_pepper,
      secret: NEXTAUTH_SECRET,
      env: process.env.NODE_ENV,
      audience: KILO_API_AUDIENCE,
      tokenPurpose: 'human-api',
      credentialExchange: false,
      expiresInSeconds: 300,
    });
    const response = await fetch(new URL('/v1/auth/exchange', SESSION_SYNC_WORKER_URL), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credential.token}` },
      body: JSON.stringify({
        version: 1,
        ...(organizationId ? { organizationID: organizationId } : {}),
      }),
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return failure(503, 'Session sync authorization is unavailable');
    }
    const result = response.body ? await readBoundedStream(response.body, 16_384) : undefined;
    if (!result?.ok) return failure(503, 'Session sync authorization is unavailable');
    const grant = grantSchema.parse(JSON.parse(new TextDecoder().decode(result.bytes)));
    const expiry = Date.parse(grant.expiresAt);
    if (
      grant.token === credential.token ||
      grant.userID !== user.id ||
      grant.tenant.type !== (organizationId ? 'organization' : 'user') ||
      grant.tenant.id !== (organizationId ?? user.id) ||
      expiry <= Date.now() ||
      expiry > Date.now() + 300_000
    )
      return failure(503, 'Session sync authorization is unavailable');
    return NextResponse.json(grant, { headers });
  } catch {
    return failure(503, 'Session sync authorization is unavailable');
  }
}
