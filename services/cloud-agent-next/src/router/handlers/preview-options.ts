import { z } from 'zod';
import { isPreviewEnabled, previewHostTemplate } from '../../preview/host.js';
import { isPreviewOwner } from '../../session-plane.js';
import { protectedProcedure } from '../auth.js';

/**
 * Tells the web app whether to offer preview for a session, and the session's
 * preview hostname with a `{port}` placeholder. The Worker's suffix turns
 * preview on and `PREVIEW_ENABLED_IDS` limits who sees it; the Worker owns the
 * label format, so the web app needs no preview configuration of its own. The
 * hostname is not a secret: entry needs a ticket. `organizationId` comes from
 * the client unverified; it only decides whether the UI shows preview.
 */
export const getPreviewOptions = protectedProcedure
  .input(
    z
      .object({
        cloudAgentSessionId: z.string().max(256),
        organizationId: z.string().max(256).optional(),
      })
      .strict()
  )
  .output(
    z.discriminatedUnion('enabled', [
      z.object({ enabled: z.literal(false) }).strict(),
      z.object({ enabled: z.literal(true), hostTemplate: z.string() }).strict(),
    ])
  )
  .query(({ ctx, input }) => {
    const suffix = ctx.env.PREVIEW_HOST_SUFFIX;
    if (!isPreviewEnabled(suffix)) return { enabled: false as const };
    if (!isPreviewOwner(ctx.env, { userId: ctx.userId, orgId: input.organizationId })) {
      return { enabled: false as const };
    }
    const hostTemplate = previewHostTemplate(input.cloudAgentSessionId, suffix);
    if (hostTemplate === null) return { enabled: false as const };
    return { enabled: true as const, hostTemplate };
  });
