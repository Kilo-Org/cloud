import type { Env } from '../types.js';
import type { SessionMetadata } from '../persistence/session-metadata.js';
import { getPgDb } from '../db/pg.js';
import { CLOUD_AGENT_REPORT_RETENTION_DAYS, createCloudAgentReportStore } from './report-store.js';

export type CloudAgentSessionFailure =
  | { stage: 'sandbox_identity'; code: 'sandbox_id_derivation_failed' }
  | { stage: 'registration'; code: 'do_registration_rejected' }
  | {
      stage: 'initial_admission';
      code: 'initial_admission_rejected' | 'initial_queue_full' | 'invalid_initial_intent';
    }
  | { stage: 'transport'; code: 'do_rpc_outcome_unknown' };

type ReportingEnv = Pick<Env, 'HYPERDRIVE'>;

export async function createCloudAgentSessionReport(
  params: {
    cloudAgentSessionId: string;
    kiloSessionId: string;
    initialMessageId: string;
    occurredAt?: string;
  },
  env: ReportingEnv
): Promise<void> {
  await createCloudAgentReportStore(getPgDb(env)).createSessionReport({
    ...params,
    occurredAt: params.occurredAt ?? new Date().toISOString(),
  });
}

export async function ensureCloneSessionReport(
  metadata: SessionMetadata | null,
  env: ReportingEnv
): Promise<void> {
  const occurredAt = metadata?.clone?.reportingCreatedAt;
  const kiloSessionId = metadata?.auth.kiloSessionId;
  const initialMessageId = metadata?.initialMessage?.id;
  if (
    !metadata?.identity.sessionId.startsWith('agent_') ||
    !occurredAt ||
    !kiloSessionId ||
    !initialMessageId ||
    Date.parse(occurredAt) <= Date.now() - CLOUD_AGENT_REPORT_RETENTION_DAYS * 24 * 60 * 60 * 1000
  ) {
    return;
  }

  const cloudAgentSessionId = metadata.identity.sessionId;
  await createCloudAgentSessionReport(
    { cloudAgentSessionId, kiloSessionId, initialMessageId, occurredAt },
    env
  );
  const sandboxId = metadata.workspace?.sandboxId;
  if (sandboxId) await recordCloudAgentSandboxIdentity({ cloudAgentSessionId, sandboxId }, env);
}

export async function recordCloudAgentSandboxIdentity(
  params: { cloudAgentSessionId: string; sandboxId: string },
  env: ReportingEnv
): Promise<void> {
  await createCloudAgentReportStore(getPgDb(env)).recordSandboxIdentity(params);
}

export async function recordCloudAgentSessionFailure(
  params: {
    cloudAgentSessionId: string;
    failure: CloudAgentSessionFailure;
    diagnostic?: { errorMessageRedacted: string; errorExpiresAt: string };
  },
  env: ReportingEnv
): Promise<void> {
  await createCloudAgentReportStore(getPgDb(env)).recordSessionFailure({
    ...params,
    occurredAt: new Date().toISOString(),
  });
}
