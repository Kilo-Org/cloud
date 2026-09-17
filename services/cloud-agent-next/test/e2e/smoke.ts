/**
 * Matrix runner: executes a suite of lifecycle × conversation pairs and
 * prints a summary table. Used for regression checks after each refactor
 * checkpoint during the cloud-agent-next queue-delivery work.
 *
 * Usage:
 *   tsx test/e2e/smoke.ts
 *
 * Not wired into `pnpm test` / `pnpm test:all` on purpose — this requires a
 * running stack (`pnpm dev:start cloud-agent`). Leave
 * `KILO_OPENROUTER_BASE` on Next.js; the driver uses `kilo/fake-deterministic`.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureTestUser, loadDevVars, loadRepoEnvFiles, DRIVER_USER_EMAIL_SUFFIX } from './auth.js';
import { DEFAULT_CONFIG, interruptSession, type ApiVersion, type DriverConfig } from './client.js';
import {
  LIFECYCLE_SCENARIOS,
  stopOwnedSessionSandboxes,
  type LifecycleResult,
} from './lifecycle.js';
import { cleanupOwnedSessions } from './smoke-cleanup.js';
import { createLocalScenarioEnvironment } from './capabilities-local.js';
import { createLocalHttpScenarioEnvironment } from './e2e-surface-client.js';
import { bootstrapDeployedProfile } from './deployed-auth.js';
import { SHARED_SCENARIOS } from './scenarios-shared.js';
import { runSharedScenario } from './scenario-capabilities.js';
import {
  buildDeployedConfig,
  exitCodeForResults,
  printResult,
  requireScenarioApi,
  resultOutcome,
} from './run.js';

const SERVICE_PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

type Case = { lifecycle: string; conversation: string; api?: ApiVersion };

/**
 * Default matrix. Ordered so the reused cold→hot happy path runs first — a
 * failure there hints at env setup issues before heavier scenarios amplify the
 * pain.
 *
 * Unified API is the default; one legacy reused-session case keeps coverage on
 * the `prepareSession` + `initiateFromKilocodeSessionV2` + `sendMessageV2`
 * surface the web UI still uses.
 */
const DEFAULT_MATRIX: Case[] = [
  // One cold boot followed by several same-session hot turns.
  { lifecycle: 'cold-hot', conversation: 'echo:hi' },

  // The individual cold/hot/follow-up admissions, now one shared definition
  // across the local and HTTP profiles.
  { lifecycle: 'cold', conversation: 'echo:hi' },
  { lifecycle: 'hot', conversation: 'echo:hi' },
  { lifecycle: 'followup', conversation: 'echo:continue' },

  // Queue semantics — the refactor focus of this branch.
  { lifecycle: 'queue-while-busy', conversation: 'gate1' },
  { lifecycle: 'queue-rapid-fire-no-gate', conversation: '_' },
  { lifecycle: 'queue-overflow', conversation: '_' },
  { lifecycle: 'queue-interrupt-clears', conversation: '_' },

  // Failure, streaming, and fake-server cleanup edge cases.
  { lifecycle: 'llm-error', conversation: 'boom' },
  { lifecycle: 'chunked-streaming', conversation: 'slow:5:50' },
  { lifecycle: 'empty-response', conversation: '_' },
  { lifecycle: 'interrupt-mid-stream', conversation: '_' },
  { lifecycle: 'interrupt-then-continue', conversation: '_' },
  { lifecycle: 'unknown-model', conversation: '_' },
  { lifecycle: 'auth-reject', conversation: '_' },
  { lifecycle: 'waiters-clean', conversation: '_' },

  // Callback delivery; the registry pins their legacy prepare flow.
  { lifecycle: 'callback-completion', conversation: 'echo:done' },
  { lifecycle: 'callback-batch-followup', conversation: '_' },
  { lifecycle: 'callback-interrupt', conversation: '_' },

  // Legacy-API sanity: one cold boot plus the same reused hot turn sequence.
  { lifecycle: 'cold-hot', conversation: 'echo:legacy', api: 'legacy' },

  // Container kill/recovery cases deliberately run last. The local Sandbox SDK
  // can continue dead-container retries after these scenarios report their
  // expected terminal signal, so later cold-start assertions should not sit
  // behind that destructive cleanup churn.
  { lifecycle: 'external-kill', conversation: 'echo:hi' },
  { lifecycle: 'kill-mid-flight', conversation: 'hang' },
];

/**
 * `E2E_LOCAL_HTTP=1`: same matrix, but the local Worker is driven over its
 * public tunnels with the deployed-style auth composition and the HTTP-only
 * capability set. Local-only (Docker-inspecting) entries are skipped, not
 * failed. This is not deployed parity evidence; it proves the HTTP profile runs
 * the shared definitions with no Docker fallback.
 */
async function mainLocalHttp(): Promise<void> {
  const profile = bootstrapDeployedProfile();
  const auth = profile.auth;
  const ownedSessionIds = new Set<string>();
  const config: DriverConfig = {
    ...buildDeployedConfig(profile, auth, {
      ...(process.env.E2E_GIT_URL ? { gitUrl: process.env.E2E_GIT_URL } : {}),
      ...(process.env.E2E_MODEL ? { model: process.env.E2E_MODEL } : {}),
    }),
    onSessionCreated: sessionId => {
      ownedSessionIds.add(sessionId);
    },
  };
  const env = createLocalHttpScenarioEnvironment({
    surfaceUrl: config.workerUrl,
    bearerToken: auth.token,
    internalApiSecret: config.internalApiSecret,
  });

  const results: LifecycleResult[] = [];
  for (const { lifecycle, conversation, api: requestedApi } of DEFAULT_MATRIX) {
    const definition = SHARED_SCENARIOS[lifecycle];
    if (!definition) {
      console.log(`\n=== ${lifecycle} [skipped: local-only, needs Docker] ===`);
      continue;
    }
    const api = requireScenarioApi(definition, requestedApi);
    if (requestedApi === 'legacy' && definition.defaultApi !== 'legacy') {
      console.log(`\n=== ${lifecycle} [skipped: local-http does not select legacy] ===`);
      continue;
    }
    console.log(`\n=== ${lifecycle}/${conversation} [api=${api}, profile=local-http] ===`);
    try {
      const result = await runSharedScenario(definition, { config, conversation, api, env });
      printResult(result);
      results.push(result);
    } finally {
      await cleanupOwnedSessions(ownedSessionIds, {
        interrupt: sessionId => interruptSession(config, sessionId),
        stopOwnedSandboxes: async () => {},
      });
      ownedSessionIds.clear();
    }
  }

  const counts = { pass: 0, failure: 0, unsupported: 0 };
  for (const result of results) counts[resultOutcome(result)] += 1;
  const unsupportedSuffix = counts.unsupported > 0 ? `, ${counts.unsupported} unsupported` : '';
  console.log(`\nSummary: ${counts.pass} passed, ${counts.failure} failed${unsupportedSuffix}`);
  process.exit(exitCodeForResults(results));
}

async function main(): Promise<void> {
  if (process.env.E2E_LOCAL_HTTP === '1') {
    await mainLocalHttp();
    return;
  }
  loadRepoEnvFiles(SERVICE_PACKAGE_DIR);
  const devVars = loadDevVars(SERVICE_PACKAGE_DIR);

  const email = `kilo-e2e-smoke-${Date.now()}${DRIVER_USER_EMAIL_SUFFIX}`;
  const user = await ensureTestUser(process.env.DATABASE_URL, email);
  console.log(`driver user: ${user.id} (${user.email})`);

  const ownedSessionIds = new Set<string>();
  const config: DriverConfig = {
    onSessionCreated: sessionId => {
      ownedSessionIds.add(sessionId);
    },
    ...DEFAULT_CONFIG,
    user,
    nextAuthSecret: devVars.NEXTAUTH_SECRET ?? '',
    internalApiSecret: devVars.INTERNAL_API_SECRET,
    workerUrl: process.env.WORKER_URL ?? DEFAULT_CONFIG.workerUrl,
    gitUrl: process.env.E2E_GIT_URL ?? DEFAULT_CONFIG.gitUrl,
    model: process.env.E2E_MODEL ?? DEFAULT_CONFIG.model,
  };

  const results: LifecycleResult[] = [];
  const env = createLocalScenarioEnvironment();
  for (const { lifecycle, conversation, api: requestedApi } of DEFAULT_MATRIX) {
    const scenarioFn = LIFECYCLE_SCENARIOS[lifecycle];
    if (!scenarioFn) {
      console.error(`smoke: unknown lifecycle ${lifecycle}`);
      continue;
    }
    const api = requireScenarioApi(
      SHARED_SCENARIOS[lifecycle] ?? { name: lifecycle },
      requestedApi
    );
    console.log(`\n=== ${lifecycle}/${conversation} [api=${api}] ===`);
    try {
      const result = await scenarioFn({ config, conversation, api, env });
      printResult(result);
      results.push(result);
    } finally {
      await cleanupOwnedSessions(ownedSessionIds, {
        interrupt: sessionId => interruptSession(config, sessionId),
        stopOwnedSandboxes: stopOwnedSessionSandboxes,
      });
      ownedSessionIds.clear();
    }
  }

  const counts = { pass: 0, failure: 0, unsupported: 0 };
  for (const result of results) counts[resultOutcome(result)] += 1;
  // The local matrix produces no unsupported result, so this line keeps its
  // two-category shape for local runs and only widens when that changes.
  const unsupportedSuffix = counts.unsupported > 0 ? `, ${counts.unsupported} unsupported` : '';
  console.log(`\nSummary: ${counts.pass} passed, ${counts.failure} failed${unsupportedSuffix}`);
  process.exit(exitCodeForResults(results));
}

main().catch(err => {
  console.error('smoke driver failed:', err);
  process.exit(1);
});
