import { successResult } from '@kilocode/web-shared/lib/maybe-result';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { revokeWebSessions } from '@kilocode/web-shared/lib/web-session-revocation';
import { NextResponse } from 'next/server';
import {
  auditAuthRoute,
  authAuditRequestFromHeaders,
  type AuthAuditAttempt,
} from '@/lib/auth/auth-audit';

export async function POST(request: Request) {
  const attempt: AuthAuditAttempt = { action: 'auth.sign_out', method: 'web' };
  return auditAuthRoute(
    authAuditRequestFromHeaders(request.headers, '/api/auth/revoke-web-session'),
    attempt,
    async () => {
      const { user } = await getUserFromAuth({
        adminOnly: false,
        DANGEROUS_allowBlockedUsers: true,
      });

      if (user) {
        attempt.userId = user.id;
        await revokeWebSessions(user.id);
      } else {
        // The browser still signs out locally; the call had no session to end.
        attempt.failureReason = 'no_session';
      }

      return NextResponse.json(successResult());
    }
  );
}
