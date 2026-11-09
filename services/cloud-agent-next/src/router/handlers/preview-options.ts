import { z } from 'zod';
import { isPreviewEnabled, previewHostTemplate } from '../../preview/host.js';
import { protectedProcedure } from '../auth.js';

/**
 * Tells the web app whether to offer preview for a session, and the session's
 * preview hostname with a `{port}` placeholder. The Worker's suffix turns
 * preview on. The hostname is not a secret: entry needs a ticket.
 */
export const getPreviewOptions = protectedProcedure
  .input(
    z
      .object({
        cloudAgentSessionId: z.string().max(256),
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
    const hostTemplate = previewHostTemplate(input.cloudAgentSessionId, suffix);
    if (hostTemplate === null) return { enabled: false as const };
    return { enabled: true as const, hostTemplate };
  });
