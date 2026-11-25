import { withDORetry } from '@kilocode/worker-utils';
import { createHourlyCheckpoint } from './checkpoint';
import {
  getVerifierDOStub,
  type StartPassResult,
  type VerifierDO,
  type VerifyPassKind,
} from './dos/VerifierDO';
import type { Env } from './env';
import { CRONS } from './schedule';

export async function handleScheduled(controller: ScheduledController, env: Env): Promise<void> {
  switch (controller.cron) {
    case CRONS.hourlyCheckpoint: {
      const result = await createHourlyCheckpoint(env);
      console.log(JSON.stringify({ event: 'audit_relay.checkpoint', ...result }));
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
