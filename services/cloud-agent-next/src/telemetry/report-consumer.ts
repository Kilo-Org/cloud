import { cli_sessions_v2, cloud_agent_sessions } from '@kilocode/db/schema';
import { CloudAgentQueueReportSchema } from '@kilocode/worker-utils/cloud-agent-queue-report';
import { eq } from 'drizzle-orm';

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
  const db = getPgDb(env);
  const reportStore = createCloudAgentReportStore(db);

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
      if (result.outcome === 'applied' && env.NOTIFICATIONS) {
        // Run liveness can change independently of session status. Refresh only after commit.
        try {
          const cloudAgentSessionId = parsed.data.session.cloudAgentSessionId;
          const [session] = await db
            .select({
              userId: cli_sessions_v2.kilo_user_id,
              cliSessionId: cli_sessions_v2.session_id,
            })
            .from(cloud_agent_sessions)
            .innerJoin(
              cli_sessions_v2,
              eq(cli_sessions_v2.session_id, cloud_agent_sessions.kilo_session_id)
            )
            .where(eq(cloud_agent_sessions.cloud_agent_session_id, cloudAgentSessionId))
            .limit(1);
          if (session) {
            await env.NOTIFICATIONS.refreshGlanceableSessions({
              userId: session.userId,
              cliSessionIds: [session.cliSessionId],
            });
          }
        } catch {
          console.warn('Cloud Agent glanceable refresh failed', {
            cloudAgentSessionId: parsed.data.session.cloudAgentSessionId,
          });
        }
      }
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
