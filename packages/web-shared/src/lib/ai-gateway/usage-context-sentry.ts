import type { MicrodollarUsageContext } from '@kilocode/web-shared/lib/ai-gateway/processUsage.types';

export function usageContextSentryExtra(ctx: MicrodollarUsageContext) {
  return {
    usageId: ctx.usageId,
    api_kind: ctx.api_kind,
    provider: ctx.provider,
    requested_model: ctx.requested_model,
    status_code: ctx.status_code,
    is_free: ctx.is_free,
    user_byok: ctx.user_byok,
    organizationId: ctx.organizationId,
    kiloUserId: ctx.kiloUserId,
  };
}
