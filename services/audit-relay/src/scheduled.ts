import { CRONS } from './schedule';
import { createHourlyCheckpoint, verifyArchivedChains } from './checkpoint';
import type { Env } from './env';

export async function handleScheduled(controller: ScheduledController, env: Env): Promise<void> {
  switch (controller.cron) {
    case CRONS.hourlyCheckpoint: {
      const result = await createHourlyCheckpoint(env);
      console.log(JSON.stringify({ event: 'audit_relay.checkpoint', ...result }));
      return;
    }
    case CRONS.dailyVerification:
      await runVerification(env, false);
      return;
    case CRONS.monthlyVerification:
      await runVerification(env, true);
      return;
    default:
      console.error(JSON.stringify({ event: 'audit_relay.unknown_cron', cron: controller.cron }));
  }
}

async function runVerification(env: Env, full: boolean): Promise<void> {
  const summary = await verifyArchivedChains(env, { full });
  console.log(JSON.stringify({ event: 'audit_relay.verification', full, ...summary }));
}
