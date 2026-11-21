import 'server-only';
import { baseProcedure, createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import { ensureMemberOrganizationAccess } from '@kilocode/web-shared/routers/organizations/utils';
import { createAppShellHandoff } from '@/lib/app-shell/handoff-token';
import {
  APP_SHELL_HANDOFF_PATH,
  appShellTargetSchema,
  buildAppShellTargetPath,
  organizationIdOfTarget,
} from '@/lib/app-shell/shell-paths';

/**
 * The bridge the native app uses to open a page it cannot render itself. The
 * mint is authenticated, so the token names the caller; the mutation decides
 * the shell path, so the browser cannot be pointed anywhere else.
 */
export const appShellRouter = createTRPCRouter({
  mintHandoff: baseProcedure.input(appShellTargetSchema).mutation(async ({ ctx, input }) => {
    const organizationId = organizationIdOfTarget(input);
    if (organizationId) {
      await ensureMemberOrganizationAccess(ctx.user, organizationId);
    }

    const token = await createAppShellHandoff({
      userId: ctx.user.id,
      targetPath: buildAppShellTargetPath(input),
    });

    return {
      path: `${APP_SHELL_HANDOFF_PATH}?${new URLSearchParams({ token }).toString()}`,
    };
  }),
});
