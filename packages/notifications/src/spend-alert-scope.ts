import type { z } from 'zod';

/**
 * A spend alert's scope and its id must agree. The tap routes by the scope, so
 * an organization alert without its id would open the personal spend view, and
 * a personal alert naming an organization would open one that did not send.
 * Both the push payload and the internal dispatch request carry the same rule.
 */
export function refineSpendAlertScope(
  data: { scope: 'personal' | 'organization'; organizationId?: string | undefined },
  ctx: z.RefinementCtx
): void {
  if (data.scope === 'organization' && data.organizationId === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['organizationId'],
      message: 'an organization-scope alert names its organization',
    });
  }
  if (data.scope === 'personal' && data.organizationId !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['organizationId'],
      message: 'a personal-scope alert carries no organization id',
    });
  }
}
