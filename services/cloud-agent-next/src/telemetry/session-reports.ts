import type { Env } from '../types.js';
import { getPgDb } from '../db/pg.js';
import { createCloudAgentReportStore } from './report-store.js';

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
  params: { cloudAgentSessionId: string; kiloSessionId: string; initialMessageId: string },
  env: ReportingEnv
): Promise<void> {
  await createCloudAgentReportStore(getPgDb(env)).createSessionReport({
    ...params,
    occurredAt: new Date().toISOString(),
  });
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
