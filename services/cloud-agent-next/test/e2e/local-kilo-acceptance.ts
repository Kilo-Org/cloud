import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { createHarness } from './local-kilo-harness.js';
import { parseOnly, runScenarios, selectScenarios } from './local-kilo-runner.js';

async function main() {
  const args = parseArgs({
    options: {
      'kilo-repo': { type: 'string' },
      bun: { type: 'string', default: 'bun' },
      email: { type: 'string' },
      out: { type: 'string' },
      only: { type: 'string', multiple: true },
    },
  }).values;
  assert(args['kilo-repo'], '--kilo-repo is required');
  assert(args.email, '--email must name an existing funded local user');
  const only = parseOnly(args.only ?? []);
  const scenarios = selectScenarios(only);
  assert(scenarios.length > 0, `No scenarios selected for --only ${only.join(',')}`);

  const harness = await createHarness({
    kiloRepo: args['kilo-repo'],
    bun: args.bun,
    email: args.email,
    out: args.out,
  });
  try {
    await runScenarios(harness, scenarios);
  } finally {
    await harness.close();
  }

  const failed = harness.results.filter(result => result.status === 'fail');
  console.log(
    `\n${harness.results.length - failed.length}/${harness.results.length} scenarios passed`
  );
  console.log(`Evidence: ${harness.out}`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
