import { type NextRequest } from 'next/server';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { user_activity_tokens } from '@kilocode/db/schema';
import { buildOpaqueScopeKey } from '@kilocode/app-shared/glanceable-agents-snapshot';
import { authenticateHomeWidget } from '@/lib/auth/home-widget-credential';
import { homeWidgetJson, homeWidgetRequest } from '@/lib/home-widget-http';

const bodySchema = z
  .object({
    token: z.string().regex(/^[a-fA-F0-9]{32,512}$/),
    enabled: z.boolean(),
  })
  .strict();

/** Bounded, widget-only registration. Account and organization come solely from the verified credential. */
export async function POST(request: NextRequest) {
  return homeWidgetRequest(async () => {
    const principal = await authenticateHomeWidget(request.headers);
    const text = await request.text();
    if (text.length > 2048) throw new TRPCError({ code: 'BAD_REQUEST' });
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new TRPCError({ code: 'BAD_REQUEST' });
    }
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) throw new TRPCError({ code: 'BAD_REQUEST' });
    const { token, enabled } = parsed.data;
    const orgPredicate =
      principal.organizationId === null
        ? isNull(user_activity_tokens.organization_id)
        : eq(user_activity_tokens.organization_id, principal.organizationId);
    if (!enabled) {
      await db
        .delete(user_activity_tokens)
        .where(
          and(
            eq(user_activity_tokens.token, token),
            eq(user_activity_tokens.user_id, principal.userId),
            eq(user_activity_tokens.kind, 'ios_widget'),
            orgPredicate
          )
        );
    } else {
      const registered = await db
        .insert(user_activity_tokens)
        .values({
          token,
          user_id: principal.userId,
          organization_id: principal.organizationId,
          kind: 'ios_widget',
          platform: 'ios',
        })
        .onConflictDoUpdate({
          target: [user_activity_tokens.token],
          set: {
            user_id: principal.userId,
            organization_id: principal.organizationId,
            updated_at: sql`now()`,
            superseded_at: null,
          },
          // The installation token binds to the account that currently holds this
          // device's widget credential; reload hints carry no data. Live Activity
          // rows are never changed here.
          setWhere: eq(user_activity_tokens.kind, 'ios_widget'),
        })
        .returning({ id: user_activity_tokens.id });
      if (registered.length === 0) throw new TRPCError({ code: 'CONFLICT' });
    }
    return homeWidgetJson({ success: true, scopeKey: buildOpaqueScopeKey(principal) });
  });
}
