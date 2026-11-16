import { z } from 'zod';

import { nonEmptyStringSchema } from './non-empty-string';

/**
 * The scope/id pair every spend-alert payload carries. It is declared once, next
 * to the rule that checks the two agree, so a new scope or a changed id bound
 * reaches the push payload and the internal dispatch request together.
 */
export const spendAlertScopeShape = {
  scope: z.enum(['personal', 'organization']),
  organizationId: nonEmptyStringSchema.optional(),
};

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
