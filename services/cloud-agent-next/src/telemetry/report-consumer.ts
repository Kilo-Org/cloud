import { CloudAgentQueueReportSchema } from '@kilocode/worker-utils/cloud-agent-queue-report';

import { getPgDb } from '../db/pg.js';
import type { Env } from '../types.js';
import { createCloudAgentReportStore } from './report-store.js';

export const CLOUD_AGENT_REPORT_QUEUE_NAMES = new Set([
  'cloud-agent-next-report-queue',
  'cloud-agent-next-report-queue-dev',
  'cloud-agent-next-report-queue-test',
]);

function parseReportWithoutInvalidDiagnostic(body: unknown) {
  if (
    typeof body !== 'object' ||
    body === null ||
    !('type' in body) ||
    body.type !== 'run.state' ||
    !('run' in body) ||
    typeof body.run !== 'object' ||
    body.run === null ||
    !('diagnostic' in body.run)
  ) {
    return CloudAgentQueueReportSchema.safeParse(body);
  }
  const diagnostic = body.run.diagnostic;
  const run =
    typeof diagnostic === 'object' && diagnostic !== null && 'facts' in diagnostic
      ? {
          ...body.run,
          diagnostic: Object.fromEntries(
            Object.entries(diagnostic).filter(([fieldName]) => fieldName !== 'facts')
          ),
        }
      : body.run;
  const parsed = CloudAgentQueueReportSchema.safeParse({ ...body, run });
  if (parsed.success) {
    return parsed;
  }
  const typedOnly = CloudAgentQueueReportSchema.safeParse({
    ...body,
    run: Object.fromEntries(
      Object.entries(run).filter(([fieldName]) => fieldName !== 'diagnostic')
    ),
  });
  if (typedOnly.success) {
    console.warn('Dropping invalid Cloud Agent report diagnostic');
  }
  return typedOnly;
}

export async function consumeCloudAgentReportBatch(
  batch: MessageBatch<unknown>,
  env: Env
): Promise<void> {
  const reportStore = createCloudAgentReportStore(getPgDb(env));

  for (const message of batch.messages) {
    const parsed = parseReportWithoutInvalidDiagnostic(message.body);
    if (!parsed.success) {
      console.warn('Dropping malformed Cloud Agent report message', {
        issueCount: parsed.error.issues.length,
      });
      message.ack();
      continue;
    }
    try {
      const result = await reportStore.saveReport(parsed.data);
      if (result.outcome === 'missing_parent') {
        console.warn('Retrying Cloud Agent run report without a session anchor', {
          cloudAgentSessionId: parsed.data.session.cloudAgentSessionId,
          messageId: parsed.data.run.messageId,
          status: parsed.data.run.status,
          attempt: message.attempts,
        });
        message.retry();
        continue;
      }
      message.ack();
    } catch {
      console.error('Saving Cloud Agent report failed; message will retry', {
        reportType: parsed.data.type,
      });
      message.retry();
    }
  }
}

export async function removeExpiredCloudAgentReportData(env: Env): Promise<void> {
  const reportStore = createCloudAgentReportStore(getPgDb(env));
  await reportStore.removeExpiredData();
}
