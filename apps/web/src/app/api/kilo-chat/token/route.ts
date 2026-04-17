import 'server-only';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { generateApiToken } from '@/lib/tokens';
import { db } from '@/lib/drizzle';
import { kiloclaw_instances } from '@kilocode/db/schema';
import { and, eq, isNull } from 'drizzle-orm';

const ONE_HOUR_SECONDS = 60 * 60;

/**
 * POST /api/kilo-chat/token
 *
 * Mints a short-lived (1 hour) Kilo JWT that the browser can use to
 * authenticate directly with the kilo-chat Cloudflare Worker.
 *
 * The browser authenticates to this endpoint via the NextAuth session cookie
 * (same-origin). The returned token is sent as `Authorization: Bearer <token>`
 * to the worker's HTTP endpoints (cross-origin).
 *
 * The worker verifies the token using verifyKiloToken() with NEXTAUTH_SECRET,
 * extracting kiloUserId from the payload.
 *
 * The token includes the user's active sandbox IDs so kilo-chat can verify
 * conversation creation requests without a cross-service call.
 */
export async function POST() {
  const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });
  if (authFailedResponse) return authFailedResponse;
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const activeInstances = await db
    .select({ sandbox_id: kiloclaw_instances.sandbox_id })
    .from(kiloclaw_instances)
    .where(and(eq(kiloclaw_instances.user_id, user.id), isNull(kiloclaw_instances.destroyed_at)));

  const kiloChatSandboxIds = activeInstances.map(r => r.sandbox_id);

  const token = generateApiToken(user, { kiloChatSandboxIds }, { expiresIn: ONE_HOUR_SECONDS });
  const expiresAt = new Date(Date.now() + 55 * 60 * 1000).toISOString();

  return NextResponse.json({ token, expiresAt });
}
