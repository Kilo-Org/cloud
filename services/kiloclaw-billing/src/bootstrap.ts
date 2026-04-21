import { getWorkerDb } from '@kilocode/db';
import type { BillingWorkerEnv } from './types.js';
import {
  bootstrapProvisionSubscriptionWithDb,
  type BootstrapProvisionInput,
} from './provision-bootstrap-shared.js';

const BOOTSTRAP_ACTOR = {
  actorType: 'system',
  actorId: 'kiloclaw-billing-bootstrap',
} as const;

export async function bootstrapProvisionSubscription(
  env: BillingWorkerEnv,
  input: BootstrapProvisionInput
) {
  const db = getWorkerDb(env.HYPERDRIVE.connectionString);

  return await bootstrapProvisionSubscriptionWithDb({
    db,
    input,
    actor: BOOTSTRAP_ACTOR,
    onChangeLogError: ({ subscriptionId, action, reason, error }) => {
      console.error('[kiloclaw-billing/bootstrap] Failed to write subscription change log', {
        subscriptionId,
        action,
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  });
}
