import { z } from 'zod';
import { fetchO11yJson } from '@/lib/ai-gateway/o11y-client';
import type { CodeReviewAlertSeverity } from './thresholds';

const CodeReviewDedupResponseSchema = z.object({
  suppressed: z.boolean(),
});

export type CodeReviewDedupResponse = z.infer<typeof CodeReviewDedupResponseSchema>;

export async function checkAndRecordAlert(
  alertKey: string,
  severity: CodeReviewAlertSeverity
): Promise<CodeReviewDedupResponse> {
  return fetchO11yJson({
    path: '/alerting/code-review-dedup',
    method: 'POST',
    body: { alertKey, severity },
    schema: CodeReviewDedupResponseSchema,
    errorMessage: 'Failed to check code review alert dedup state',
    parseErrorMessage: 'Invalid code review alert dedup response',
  });
}
