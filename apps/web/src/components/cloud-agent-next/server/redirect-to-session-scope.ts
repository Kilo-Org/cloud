import 'server-only';
import { redirect } from 'next/navigation';
import { and, eq } from 'drizzle-orm';
import { cli_sessions_v2 } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { sessionScopeHref } from '@/lib/cloud-agent/session-resume-target';
import { getAuthorizedOrgContext } from '@/lib/organizations/organization-auth';

/**
 * The stream refuses a session outside the chat page's account scope, so a link
 * from another scope goes to the chat page that owns the session. It stays when
 * the user cannot open that page: the chat then shows the denial. A chat that
 * this client created and the server does not know yet also stays.
 */
export async function redirectToSessionScope({
  sessionId,
  userId,
  organizationId,
  anchorMessageId,
}: {
  sessionId: string;
  userId: string;
  organizationId: string | null;
  anchorMessageId: string | null;
}): Promise<void> {
  const [session] = await db
    .select({
      session_id: cli_sessions_v2.session_id,
      organization_id: cli_sessions_v2.organization_id,
    })
    .from(cli_sessions_v2)
    .where(and(eq(cli_sessions_v2.session_id, sessionId), eq(cli_sessions_v2.kilo_user_id, userId)))
    .limit(1);
  const href = session ? sessionScopeHref(session, organizationId, anchorMessageId) : null;
  if (!href) return;
  if (session?.organization_id) {
    const target = await getAuthorizedOrgContext(session.organization_id);
    if (!target.success) return;
  }
  redirect(href);
}
