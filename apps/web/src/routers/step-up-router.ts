import 'server-only';
import { TRPCError } from '@trpc/server';
import { isReleaseToggleEnabled } from '@kilocode/web-shared/lib/posthog-feature-flags';
import {
  evaluateStepUp,
  revokeCurrentSessionStepUpProofs,
} from '@kilocode/web-shared/lib/admin/step-up-store';
import { ADMIN_STEP_UP_ENROLLMENT_FLAG } from '@kilocode/web-shared/lib/admin/step-up-policy';
import { getAdminStepUpMode } from '@kilocode/web-shared/lib/config.server';
import { reportStepUpFailure } from '@kilocode/web-shared/lib/admin/step-up-observation';
import { adminProcedure, createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';

function assertBrowserSession(ctx: { credential?: string }): void {
  if (ctx.credential !== 'session') {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Browser session required' });
  }
}

export const stepUpRouter = createTRPCRouter({
  /**
   * Observe-only status for the admin shell. A bearer credential is refused
   * because a proof can only ever bind to a browser session.
   */
  getStatus: adminProcedure.query(async ({ ctx }) => {
    assertBrowserSession(ctx);

    const mode = getAdminStepUpMode();
    const enrollmentEnabled = await isReleaseToggleEnabled(
      ADMIN_STEP_UP_ENROLLMENT_FLAG,
      ctx.user.id
    );

    if (mode === 'off' && !enrollmentEnabled) {
      return {
        enrolled: false,
        passkeyCount: 0,
        sessionBound: Boolean(ctx.webSessionId),
        fresh: false,
        status: { status: 'absent' as const },
        mode,
        enrollmentEnabled: false,
      };
    }

    let evaluation;
    try {
      evaluation = await evaluateStepUp({
        userId: ctx.user.id,
        webSessionId: ctx.webSessionId,
        actionClass: 'platform_read',
      });
    } catch (error) {
      reportStepUpFailure('admin_step_up_status', error);
      return {
        enrolled: false,
        passkeyCount: 0,
        sessionBound: Boolean(ctx.webSessionId),
        fresh: false,
        status: { status: 'absent' as const },
        mode,
        enrollmentEnabled,
      };
    }

    return {
      enrolled: evaluation.passkeyCount > 0,
      passkeyCount: evaluation.passkeyCount,
      sessionBound: Boolean(ctx.webSessionId),
      fresh: evaluation.state.status === 'fresh',
      status: evaluation.state,
      mode,
      enrollmentEnabled,
    };
  }),

  /** "Lock now": revoke every live proof bound to this browser session. */
  revokeCurrent: adminProcedure.mutation(async ({ ctx }) => {
    assertBrowserSession(ctx);

    if (!ctx.webSessionId) {
      return { revoked: 0 };
    }

    try {
      const revoked = await revokeCurrentSessionStepUpProofs(
        ctx.user.id,
        ctx.webSessionId,
        'user_lock'
      );
      return { revoked };
    } catch (error) {
      // Drizzle errors embed statement parameters such as the session hash.
      // Report only the error shape and give the client a generic refusal.
      reportStepUpFailure('admin_step_up_revoke_current', error);
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Could not lock this session. Try again.',
      });
    }
  }),
});
