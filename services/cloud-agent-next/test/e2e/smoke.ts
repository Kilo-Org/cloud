/**
 * Matrix runner: executes every shared scenario in `SHARED_SCENARIOS` and prints
 * a summary table. Used for regression checks after each refactor checkpoint.
 *
 * Both paths dispatch `SHARED_SCENARIOS` through `runSharedScenario`. A matrix
 * name absent from `SHARED_SCENARIOS` is a hard failure, never a silent skip,
 * so no entrypoint can run a different implementation of the same name.
 *
 * Usage:
 *   tsx test/e2e/smoke.ts
 *
 * Not wired into `pnpm test` / `pnpm test:all` on purpose — this requires a
 * running stack (`pnpm dev:start cloud-agent`). Leave
 * `KILO_OPENROUTER_BASE` on Next.js; the driver uses `kilo/fake-deterministic`.
 *
 * `DEFAULT_MATRIX` names every shared scenario exactly once; the only extra runs
 * are API-variant cases (`cold-hot` unified and legacy). The `sandboxFaults`
 * scenarios run last because they stop or freeze a real container. Worktree
 * creation needs a driver user enrolled in `CONTROL_PLANE_IDS` and
 * `WORKTREE_CREATION_ENABLED_IDS`; set `E2E_USER_EMAIL` to that seeded user.
 * Without enrollment those scenarios are kept in the matrix and reported as
 * failures rather than omitted. Local expected-unsupported is exactly
 * `auth-reject`, which declares the deployed HTTP auth boundary.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ensureTestUser,
  loadDevVars,
  loadExistingUserByEmail,
  loadRepoEnvFiles,
  DRIVER_USER_EMAIL_SUFFIX,
} from './auth.js';
import { DEFAULT_CONFIG, interruptSession, type ApiVersion, type DriverConfig } from './client.js';
import { stopOwnedSessionSandboxes, type LifecycleResult } from './lifecycle.js';
import { cleanupOwnedSessions } from './smoke-cleanup.js';
import { createLocalScenarioEnvironment } from './capabilities-local.js';
import { createLocalHttpScenarioEnvironment } from './e2e-surface-client.js';
import { bootstrapDeployedProfile } from './deployed-auth.js';
import { SHARED_SCENARIOS } from './scenarios-shared.js';
import {
  isScenarioSupported,
  runSharedScenario,
  type ScenarioEnvironment,
} from './scenario-capabilities.js';
import { isControlPlaneOwner, isWorktreeOwner } from '../../src/session-plane.js';
import {
  buildDeployedConfig,
  exitCodeForResults,
  printResult,
  requireScenarioApi,
  resultOutcome,
  WORKTREE_ENROLLMENT_SCENARIOS,
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

  // The individual cold/hot admissions, one shared definition across profiles.
  { lifecycle: 'cold', conversation: 'echo:hi' },
  { lifecycle: 'hot', conversation: 'echo:hi' },

  // Queue semantics: the hold is a bounded paced turn.
  { lifecycle: 'queue-while-busy', conversation: '_' },
  { lifecycle: 'queue-rapid-fire-no-gate', conversation: '_' },
  { lifecycle: 'queue-overflow', conversation: '_' },
  { lifecycle: 'queue-interrupt-clears', conversation: '_' },

  // Failure, streaming, and cleanup edge cases.
  { lifecycle: 'llm-error', conversation: 'boom' },
  { lifecycle: 'chunked-streaming', conversation: 'slow:5:50' },
  { lifecycle: 'empty-response', conversation: '_' },
  { lifecycle: 'interrupt-mid-stream', conversation: '_' },
  { lifecycle: 'interrupt-then-continue', conversation: '_' },
  { lifecycle: 'unknown-model', conversation: '_' },
  { lifecycle: 'auth-reject', conversation: '_' },

  // Callback delivery; the registry pins their legacy prepare flow.
  { lifecycle: 'callback-completion', conversation: 'echo:done' },
  { lifecycle: 'callback-batch-followup', conversation: '_' },
  { lifecycle: 'callback-interrupt', conversation: '_' },

  // Worktree creation and long continuity. These need an enrolled driver user.
  { lifecycle: 'worktree-chat', conversation: '_' },
  { lifecycle: 'worktree-multi-chat', conversation: '_' },
  { lifecycle: 'long-conversation', conversation: '_' },
  { lifecycle: 'leave-and-return', conversation: '_' },
  { lifecycle: 'large-stream', conversation: '_' },
  { lifecycle: 'concurrent-chats', conversation: '_' },
  { lifecycle: 'question-idle-resume', conversation: '_' },

  // Legacy-API sanity: one cold boot plus the same reused hot turn sequence.
  { lifecycle: 'cold-hot', conversation: 'echo:legacy', api: 'legacy' },

  // Physical faults run last: they stop or freeze a real container.
  { lifecycle: 'external-kill', conversation: '_' },
  { lifecycle: 'kill-mid-flight', conversation: '_' },
  { lifecycle: 'wrapper-freeze-settled-reap', conversation: '_' },
  { lifecycle: 'wrapper-freeze-inflight-reap', conversation: '_' },
];

function unknownLifecycleFailure(lifecycle: string, conversation: string): LifecycleResult {
  return {
    name: lifecycle,
    conversation,
    ok: false,
    message: `unknown lifecycle ${lifecycle} (not in SHARED_SCENARIOS)`,
    events: [],
    durationMs: 0,
  };
}

/** Names in the matrix whose declaration this environment cannot satisfy. */
function expectedUnsupportedFor(env: ScenarioEnvironment, names: readonly string[]): Set<string> {
  return new Set(
    names.filter(name => {
      const definition = SHARED_SCENARIOS[name];
      return definition !== undefined && !isScenarioSupported(definition, env);
    })
  );
}

/**
 * `E2E_LOCAL_HTTP=1`: same matrix, but the local Worker is driven over its
 * public tunnels with the deployed-style auth composition and the HTTP-only
 * capability set. Legacy-pinned cases are skipped, not failed. This is not
 * deployed parity evidence; it proves the HTTP profile runs the shared
 * definitions with no Docker fallback.
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
  const executed: string[] = [];
  for (const { lifecycle, conversation, api: requestedApi } of DEFAULT_MATRIX) {
    const definition = SHARED_SCENARIOS[lifecycle];
    if (!definition) {
      console.error(`smoke: unknown lifecycle ${lifecycle}`);
      results.push(unknownLifecycleFailure(lifecycle, conversation));
      continue;
    }
    if (requestedApi === 'legacy' && definition.defaultApi !== 'legacy') {
      console.log(`\n=== ${lifecycle} [skipped: local-http does not select legacy] ===`);
      continue;
    }
    const api = requireScenarioApi(definition, requestedApi);
    console.log(`\n=== ${lifecycle}/${conversation} [api=${api}, profile=local-http] ===`);
    try {
      const result = await runSharedScenario(definition, {
        config,
        conversation,
        api,
        env,
        ...(definition.defaultTimeoutMs !== undefined
          ? { timeoutMs: definition.defaultTimeoutMs }
          : {}),
      });
      printResult(result);
      results.push(result);
      executed.push(lifecycle);
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
  process.exit(
    exitCodeForResults(results, { expectedUnsupported: expectedUnsupportedFor(env, executed) })
  );
}

async function main(): Promise<void> {
  if (process.env.E2E_LOCAL_HTTP === '1') {
    await mainLocalHttp();
    return;
  }
  loadRepoEnvFiles(SERVICE_PACKAGE_DIR);
  const devVars = loadDevVars(SERVICE_PACKAGE_DIR);

  const email = `kilo-e2e-smoke-${Date.now()}${DRIVER_USER_EMAIL_SUFFIX}`;
  const seededEmail = process.env.E2E_USER_EMAIL?.trim();
  const user = seededEmail
    ? await loadExistingUserByEmail(process.env.DATABASE_URL, seededEmail)
    : await ensureTestUser(process.env.DATABASE_URL, email);
  const expectControlPlane = Boolean(devVars.CONTROL_PLANE_IDS?.trim());
  console.log(`driver user: ${user.id} (${user.email}); controlPlane=${expectControlPlane}`);

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
    fakeLlmUrl: process.env.FAKE_LLM_URL ?? DEFAULT_CONFIG.fakeLlmUrl,
    expectControlPlane,
    gitUrl: process.env.E2E_GIT_URL ?? DEFAULT_CONFIG.gitUrl,
    model: process.env.E2E_MODEL ?? DEFAULT_CONFIG.model,
  };

  const results: LifecycleResult[] = [];
  const executed: string[] = [];
  const env = createLocalScenarioEnvironment();
  for (const { lifecycle, conversation, api: requestedApi } of DEFAULT_MATRIX) {
    const definition = SHARED_SCENARIOS[lifecycle];
    if (!definition) {
      console.error(`smoke: unknown lifecycle ${lifecycle}`);
      results.push(unknownLifecycleFailure(lifecycle, conversation));
      continue;
    }
    const api = requireScenarioApi(definition, requestedApi);
    if (
      WORKTREE_ENROLLMENT_SCENARIOS.has(lifecycle) &&
      (!isControlPlaneOwner(devVars, { userId: user.id }) ||
        !isWorktreeOwner(devVars, { userId: user.id }))
    ) {
      const message =
        `${lifecycle} requires the driver user to be enrolled in CONTROL_PLANE_IDS and ` +
        'WORKTREE_CREATION_ENABLED_IDS in the Worker .dev.vars; no session was started';
      console.error(`smoke: ${message}`);
      results.push({
        name: lifecycle,
        conversation,
        ok: false,
        message,
        events: [],
        durationMs: 0,
      });
      continue;
    }
    console.log(`\n=== ${lifecycle}/${conversation} [api=${api}] ===`);
    try {
      const result = await runSharedScenario(definition, {
        config,
        conversation,
        api,
        env,
        ...(definition.defaultTimeoutMs !== undefined
          ? { timeoutMs: definition.defaultTimeoutMs }
          : {}),
      });
      printResult(result);
      results.push(result);
      executed.push(lifecycle);
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
  const unsupportedSuffix = counts.unsupported > 0 ? `, ${counts.unsupported} unsupported` : '';
  console.log(`\nSummary: ${counts.pass} passed, ${counts.failure} failed${unsupportedSuffix}`);
  process.exit(
    exitCodeForResults(results, { expectedUnsupported: expectedUnsupportedFor(env, executed) })
  );
}

main().catch(err => {
  console.error('smoke driver failed:', err);
  process.exit(1);
});
