import { withDORetry } from '@kilocode/worker-utils';
import { createHourlyCheckpoint } from './checkpoint';
import {
  getVerifierDOStub,
  type StartPassResult,
  type VerifierDO,
  type VerifyPassKind,
} from './dos/VerifierDO';
import type { Env } from './env';
import { pageOperator } from './page';
import { errorName } from './relay/error-name';
import { CRONS } from './schedule';

export async function handleScheduled(controller: ScheduledController, env: Env): Promise<void> {
  switch (controller.cron) {
    case CRONS.hourlyCheckpoint: {
      try {
        const result = await createHourlyCheckpoint(env, controller.scheduledTime);
        console.log(JSON.stringify({ event: 'audit_relay.checkpoint', ...result }));
      } catch (error) {
        // A checkpoint that silently stops is the failure verification cannot see on its own.
        console.error(
          JSON.stringify({ event: 'audit_relay.checkpoint_failed', error: errorName(error) })
        );
        await pageOperator(
          env,
          `audit-relay could not write the hourly checkpoint (${errorName(error)}); the next hour retries`
        );
        throw error;
      }
      return;
    }
    case CRONS.dailyVerification:
      await startVerification(env, 'daily');
      return;
    case CRONS.monthlyVerification:
      await startVerification(env, 'full');
      return;
    default:
      console.error(JSON.stringify({ event: 'audit_relay.unknown_cron', cron: controller.cron }));
  }
}

/** Starts a pass; the verifier then walks it in alarm-driven slices and pages on a failure. */
async function startVerification(env: Env, kind: VerifyPassKind): Promise<void> {
  const result = await withDORetry<DurableObjectStub<VerifierDO>, StartPassResult>(
    () => getVerifierDOStub(env),
    stub => stub.startPass(kind),
    'startPass'
  );
  console.log(JSON.stringify({ event: 'audit_relay.verification_start', ...result }));
}
