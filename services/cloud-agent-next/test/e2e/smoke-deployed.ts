/**
 * Deployed matrix runner: runs every shared scenario against a deployed Worker
 * and reports passed / failed / unsupported as distinct categories.
 *
 * It is the deployed-profile counterpart to `smoke.ts`, not a profile switch in
 * it: the local matrix inserts a Postgres user, loads `.dev.vars`/root env
 * files, and stops Docker sandboxes, none of which exists here. Every scenario
 * reaches the shared gate through `runSharedScenario`; the scenario keeps
 * ownership of its own cleanup, and this runner only backstops session ids it
 * tracked through `onSessionCreated`.
 *
 * Usage:
 *   pnpm --filter cloud-agent-next run e2e:deployed
 *
 * Exit policy: 1 if any scenario failed, else 2 if any scenario was
 * unsupported that this profile does not expect, else 0. A scenario whose
 * `requires` names a capability the deployed profile does not provide is
 * reported `unsupported` and does not fail the run.
 */

import { bootstrapDeployedProfile } from './deployed-auth.js';
import type { DriverConfig } from './client.js';
import type { LifecycleResult } from './lifecycle.js';
import {
  buildDeployedConfig,
  exitCodeForResults,
  printResult,
  requireScenarioApi,
  resultOutcome,
} from './run.js';
import { createDeployedScenarioEnvironment } from './capabilities-deployed.js';
import { isScenarioSupported, runSharedScenario } from './scenario-capabilities.js';
import { cleanupRemoteSession, SHARED_SCENARIOS } from './scenarios-shared.js';

async function main(): Promise<void> {
  const profile = bootstrapDeployedProfile();
  const trackedSessionIds = new Set<string>();
  const config: DriverConfig = {
    ...buildDeployedConfig(profile, profile.auth, {
      ...(process.env.E2E_GIT_URL ? { gitUrl: process.env.E2E_GIT_URL } : {}),
      ...(process.env.E2E_MODEL ? { model: process.env.E2E_MODEL } : {}),
    }),
    onSessionCreated: sessionId => {
      trackedSessionIds.add(sessionId);
    },
  };
  // The e2e surface is mounted on the same Worker URL; slice 2 adds its own
  // deployment knob. Passing it here keeps every shared scenario runnable
  // instead of silently unsupported.
  const env = createDeployedScenarioEnvironment({
    surfaceUrl: profile.workerUrl,
    bearerToken: profile.auth.token,
    internalApiSecret: config.internalApiSecret,
  });

  const results: LifecycleResult[] = [];
  for (const [name, definition] of Object.entries(SHARED_SCENARIOS)) {
    const api = requireScenarioApi(definition, undefined);
    console.log(`\n=== ${name}/${definition.defaultConversation} [api=${api}] ===`);
    const result = await runSharedScenario(definition, {
      config,
      conversation: definition.defaultConversation,
      api,
      ...(definition.defaultTimeoutMs !== undefined
        ? { timeoutMs: definition.defaultTimeoutMs }
        : {}),
      env,
    });
    printResult(result);
    results.push(result);

    // Backstop only: the scenario's `finally` already cleaned what it started.
    // Repeating interrupt/delete is idempotent, and a failure is logged rather
    // than thrown so one stuck session cannot hide the remaining scenarios.
    for (const sessionId of trackedSessionIds) {
      await cleanupRemoteSession(config, sessionId, name);
    }
    trackedSessionIds.clear();
  }

  const counts = { pass: 0, failure: 0, unsupported: 0 };
  for (const result of results) counts[resultOutcome(result)] += 1;
  console.log(
    `\nSummary: ${counts.pass} passed, ${counts.failure} failed, ${counts.unsupported} unsupported`
  );
  for (const result of results) {
    if (resultOutcome(result) === 'unsupported') {
      console.log(`unsupported: ${result.name}: ${result.message}`);
    }
  }

  process.exit(
    exitCodeForResults(results, {
      expectedUnsupported: expectedUnsupportedFor(env),
    })
  );
}

/** Names whose declared capabilities this profile cannot satisfy (derived). */
function expectedUnsupportedFor(
  env: ReturnType<typeof createDeployedScenarioEnvironment>
): Set<string> {
  return new Set(
    Object.entries(SHARED_SCENARIOS)
      .filter(([, definition]) => !isScenarioSupported(definition, env))
      .map(([name]) => name)
  );
}

main().catch(err => {
  console.error('deployed smoke driver failed:', err);
  process.exit(1);
});
