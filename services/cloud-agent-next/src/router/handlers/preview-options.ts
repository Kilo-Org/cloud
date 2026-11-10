import { z } from 'zod';
import { isPreviewEnabled, previewHostTemplate, previewTargetId } from '../../preview/host.js';
import { previewTargetSchema } from '../../shared/preview-target.js';
import { protectedProcedure } from '../auth.js';

const previewOptionsInputSchema = z
  .object({
    worktreeId: z.string().max(256).optional(),
    cloudAgentSessionId: z.string().max(256).optional(),
    organizationId: z.string().max(256).optional(),
  })
  .strict()
  .transform((input, ctx) => {
    const target = previewTargetSchema.safeParse(input);
    if (!target.success) {
      ctx.addIssue({ code: 'custom', message: 'Expected exactly one preview target' });
      return z.NEVER;
    }
    return { target: target.data, organizationId: input.organizationId };
  });

/**
 * Tells the web app whether to offer preview for a target, and its preview
 * hostname with a `{port}` placeholder. The Worker's suffix turns preview on;
 * the Worker owns the label format, so the web app needs no preview
 * configuration of its own. The hostname is not a secret: entry needs a ticket.
 * `organizationId` is accepted from older clients and ignored.
 */
export const getPreviewOptions = protectedProcedure
  .input(previewOptionsInputSchema)
  .output(
    z.discriminatedUnion('enabled', [
      z.object({ enabled: z.literal(false) }).strict(),
      z.object({ enabled: z.literal(true), hostTemplate: z.string() }).strict(),
    ])
  )
  .query(({ ctx, input }) => {
    const suffix = ctx.env.PREVIEW_HOST_SUFFIX;
    if (!isPreviewEnabled(suffix)) return { enabled: false as const };
    const targetId = previewTargetId(input.target);
    if (targetId === null) return { enabled: false as const };
    const hostTemplate = previewHostTemplate(targetId, suffix);
    if (hostTemplate === null) return { enabled: false as const };
    return { enabled: true as const, hostTemplate };
  });
