import type { Hono } from 'hono';
import { z } from 'zod';
import { zodJsonValidator } from '@kilocode/worker-utils';
import { requireAdmin } from '../admin-middleware';
import { PAGE_COOLDOWN_SECONDS, TICKET_COOLDOWN_SECONDS, type AlertSeverity } from './slo-config';

const CodeReviewDedupInputSchema = z.object({
  action: z.enum(['check', 'record']),
  alertKey: z.string().trim().min(1).max(200),
  severity: z.enum(['page', 'ticket']),
});

function codeReviewAlertKey(severity: AlertSeverity, alertKey: string): string {
  return `o11y:alert:code_review:${severity}:${alertKey}`;
}

function cooldownForSeverity(severity: AlertSeverity): number {
  return severity === 'page' ? PAGE_COOLDOWN_SECONDS : TICKET_COOLDOWN_SECONDS;
}

export function registerCodeReviewDedupRoutes(app: Hono<{ Bindings: Env }>): void {
  app.post(
    '/alerting/code-review-dedup',
    requireAdmin,
    zodJsonValidator(CodeReviewDedupInputSchema),
    async c => {
      const { action, alertKey, severity } = c.req.valid('json');
      const kvKey = codeReviewAlertKey(severity, alertKey);

      if (action === 'check') {
        const existing = await c.env.O11Y_ALERT_STATE.get(kvKey);
        return c.json({ suppressed: Boolean(existing) });
      }

      await c.env.O11Y_ALERT_STATE.put(kvKey, new Date().toISOString(), {
        expirationTtl: cooldownForSeverity(severity),
      });

      return c.json({ success: true });
    }
  );
}
