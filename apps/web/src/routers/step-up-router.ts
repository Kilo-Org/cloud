import 'server-only';
import { TRPCError } from '@trpc/server';
import { evaluateStepUp } from '@kilocode/web-shared/lib/admin/step-up-store';
import { isAdminStepUpEnabled } from '@kilocode/web-shared/lib/config.server';
import { reportStepUpFailure } from '@kilocode/web-shared/lib/admin/step-up-observation';
import { adminProcedure, createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';

function assertBrowserSession(ctx: { credential?: string }): void {
  if (ctx.credential !== 'session') {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Browser session required' });
  }
}

export const stepUpRouter = createTRPCRouter({
  /**
   * Status for the verification dialog. Exempt from the admin step-up guard so
   * it can report enrollment and freshness while the session is not verified;
   * it still requires an admin browser session.
   */
  getStatus: adminProcedure.query(async ({ ctx }) => {
    assertBrowserSession(ctx);

    if (!isAdminStepUpEnabled()) {
      return {
        enrolled: false,
        passkeyCount: 0,
        sessionBound: Boolean(ctx.webSessionId),
        fresh: false,
        status: { status: 'absent' as const },
        unavailable: false,
      };
    }

    try {
      const evaluation = await evaluateStepUp({
        userId: ctx.user.id,
        webSessionId: ctx.webSessionId,
        actionClass: 'platform_read',
      });
      return {
        enrolled: evaluation.passkeyCount > 0,
        passkeyCount: evaluation.passkeyCount,
        sessionBound: Boolean(ctx.webSessionId),
        fresh: evaluation.state.status === 'fresh',
        status: evaluation.state,
        unavailable: false,
      };
    } catch (error) {
      reportStepUpFailure('admin_step_up_status', error);
      return {
        enrolled: false,
        passkeyCount: 0,
        sessionBound: Boolean(ctx.webSessionId),
        fresh: false,
        status: { status: 'absent' as const },
        unavailable: true,
      };
    }
  }),
});
