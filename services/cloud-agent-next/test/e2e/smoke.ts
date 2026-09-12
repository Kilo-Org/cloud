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
import { printResult } from './run.js';

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

  // Queue semantics — the refactor focus of this branch.
  { lifecycle: 'queue-while-busy', conversation: 'gate1' },
  { lifecycle: 'queue-overflow', conversation: '_' },
  { lifecycle: 'queue-interrupt-clears', conversation: '_' },

  // Failure, streaming, and fake-server cleanup edge cases.
  { lifecycle: 'llm-error', conversation: 'boom' },
  { lifecycle: 'chunked-streaming', conversation: 'slow:5:50' },
  { lifecycle: 'empty-response', conversation: '_' },
  { lifecycle: 'interrupt-mid-stream', conversation: '_' },
  { lifecycle: 'unknown-model', conversation: '_' },
  { lifecycle: 'waiters-clean', conversation: '_' },

  // Callback scenarios remain manual because callbackTarget uses the internal legacy API.

  // Legacy-API sanity: one cold boot plus the same reused hot turn sequence.
  { lifecycle: 'cold-hot', conversation: 'echo:legacy', api: 'legacy' },

  // Container kill/recovery cases deliberately run last. The local Sandbox SDK
  // can continue dead-container retries after these scenarios report their
  // expected terminal signal, so later cold-start assertions should not sit
  // behind that destructive cleanup churn.
  { lifecycle: 'external-kill', conversation: 'echo:hi' },
  { lifecycle: 'kill-mid-flight', conversation: 'hang' },
];

async function main(): Promise<void> {
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
  for (const { lifecycle, conversation, api = 'unified' } of DEFAULT_MATRIX) {
    const scenarioFn = LIFECYCLE_SCENARIOS[lifecycle];
    if (!scenarioFn) {
      console.error(`smoke: unknown lifecycle ${lifecycle}`);
      continue;
    }
    console.log(`\n=== ${lifecycle}/${conversation} [api=${api}] ===`);
    try {
      const result = await scenarioFn({ config, conversation, api });
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

  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;
  console.log(`\nSummary: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('smoke driver failed:', err);
  process.exit(1);
});
