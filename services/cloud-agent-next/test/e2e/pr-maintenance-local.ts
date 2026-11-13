import path from 'node:path';
import { z } from 'zod';
import { openContext } from './pr-maintenance-local/context.js';
import { prepare } from './pr-maintenance-local/fixtures.js';
import { cleanupBootstrapOnly, hasSavedState } from './pr-maintenance-local/cleanup.js';
import { stopBeforeStart, resultContinuation } from './pr-maintenance-local/review-scenarios.js';
import {
  coordination,
  runtime,
  question,
  answer,
  answerCold,
  cleanup,
} from './pr-maintenance-local/scenarios.js';

const phaseSchema = z.enum([
  'prepare',
  'coordination',
  'runtime',
  'question',
  'answer',
  'answer-cold',
  'cleanup',
  'stop-before-start',
  'result-continuation',
]);
const phase = phaseSchema.safeParse(process.argv[2]);
const directory = process.argv[3];
if (!phase.success || !directory || process.argv.length !== 4) {
  console.error(
    'Usage: tsx test/e2e/pr-maintenance-local.ts <prepare|coordination|runtime|question|answer|answer-cold|stop-before-start|result-continuation|cleanup> dev/logs/<new-private-run>'
  );
  process.exitCode = 1;
} else {
  const watchdog = setTimeout(() => {
    console.error(
      'Maintenance acceptance reached its 180-second deadline. Private receipts retain uncertain operation IDs.'
    );
    process.exit(1);
  }, 180_000);
  try {
    const context = await openContext(path.resolve(directory), phase.data);
    let failure: unknown;
    try {
      if (phase.data === 'prepare') await prepare(context);
      else if (phase.data === 'cleanup' && !(await hasSavedState(context))) {
        await cleanupBootstrapOnly(context);
      } else {
        const { state } = await context.load();
        switch (phase.data) {
          case 'coordination':
            await coordination(context, state);
            break;
          case 'runtime':
            await runtime(context, state);
            break;
          case 'question':
            await question(context, state);
            break;
          case 'answer':
            await answer(context, state);
            break;
          case 'answer-cold':
            await answerCold(context, state);
            break;
          case 'cleanup':
            await cleanup(context, state);
            break;
          case 'stop-before-start':
            await stopBeforeStart(context, state);
            break;
          case 'result-continuation':
            await resultContinuation(context, state);
            break;
        }
      }
    } catch (error) {
      failure = error;
    }
    const summary = await context.finish(failure);
    console.log(JSON.stringify(summary));
    if (failure) process.exitCode = 1;
    else if (summary.blocked.length) process.exitCode = 2;
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Local maintenance preflight failed');
    process.exitCode = 1;
  } finally {
    clearTimeout(watchdog);
  }
}
