/**
 * Matrix runner: executes a suite of lifecycle × conversation pairs and
 * prints a summary table. Used for regression checks after each refactor
 * checkpoint during the cloud-agent-next queue-delivery work.
 *
 * Usage:
 *   tsx test/e2e/smoke.ts
 *
 * Not wired into `pnpm test` / `pnpm test:all` on purpose — this requires a
 * running stack with the fake-LLM harness configured:
 *   1. Edit `.dev.vars` so `KILO_OPENROUTER_BASE` points at the fake LLM:
 *        `KILO_OPENROUTER_BASE=http://localhost:<8811 + portOffset>/api`
 *   2. `pnpm dev:start cloud-agent fake-llm`
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureTestUser, loadDevVars, loadRepoEnvFiles, DRIVER_USER_EMAIL_SUFFIX } from './auth.js';
import {
  cleanupSessionUntilSettled,
  DEFAULT_CONFIG,
  type ApiVersion,
  type DriverConfig,
} from './client.js';
import { LIFECYCLE_SCENARIOS, type LifecycleResult } from './lifecycle.js';
import { printResult } from './run.js';
import {
  killSandboxFamily,
  listSandboxContainers,
  removeSandboxFamily,
  sandboxFamilyKey,
  waitForSandboxCleanupQuiescence,
  waitForSandboxFamilyGone,
  type SandboxContainer,
} from './sandbox-control.js';

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
  { lifecycle: 'classified-failure-report', conversation: 'payment' },
  { lifecycle: 'classified-failure-report', conversation: 'model' },
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

async function cleanupMatrixSandboxes(baselineSandboxIds: Set<string>): Promise<string | null> {
  const createdSandboxes = (await listSandboxContainers()).filter(
    container => !baselineSandboxIds.has(container.id)
  );
  const sandboxFamilies = new Map<string, SandboxContainer>();
  for (const container of createdSandboxes) {
    const key = sandboxFamilyKey(container);
    const existing = sandboxFamilies.get(key);
    if (!existing || (existing.isProxy && !container.isProxy)) sandboxFamilies.set(key, container);
  }
  for (const sandbox of sandboxFamilies.values()) await removeSandboxFamily(sandbox);

  const quiescent = await waitForSandboxCleanupQuiescence(baselineSandboxIds, {
    timeoutMs: 30_000,
    stableMs: 5_000,
    reapPostBaseline: true,
  });
  if (quiescent) return null;

  const remainingSandboxes = (await listSandboxContainers()).filter(
    container => !baselineSandboxIds.has(container.id)
  );
  const remaining = remainingSandboxes.map(container => container.name);
  return remaining.length > 0
    ? `post-cleanup Docker state did not quiesce: ${remaining.join(', ')}`
    : 'sandbox cleanup did not remain stable for 5s';
}

async function main(): Promise<void> {
  loadRepoEnvFiles(SERVICE_PACKAGE_DIR);
  const devVars = loadDevVars(SERVICE_PACKAGE_DIR);

  const email = `kilo-e2e-smoke-${Date.now()}${DRIVER_USER_EMAIL_SUFFIX}`;
  const user = await ensureTestUser(process.env.DATABASE_URL, email);
  console.log(`driver user: ${user.id} (${user.email})`);

  const config: DriverConfig = {
    ...DEFAULT_CONFIG,
    user,
    nextAuthSecret: devVars.NEXTAUTH_SECRET ?? '',
    internalApiSecret: devVars.INTERNAL_API_SECRET,
    workerUrl: process.env.WORKER_URL ?? DEFAULT_CONFIG.workerUrl,
    databaseUrl: process.env.DATABASE_URL,
    gitUrl: process.env.E2E_GIT_URL ?? DEFAULT_CONFIG.gitUrl,
    model: process.env.E2E_MODEL ?? DEFAULT_CONFIG.model,
  };

  // Kill stale sandbox containers from previous runs before starting.
  // Accumulated stopped/running containers degrade Docker Desktop performance
  // and cause the preparing×7 wrapper-startup stall pattern. The baseline
  // snapshot below only identifies *new* containers, so leftovers from prior
  // runs would be skipped by cleanupMatrixSandboxes.
  const staleContainers = await listSandboxContainers();
  if (staleContainers.length > 0) {
    console.log(`smoke: cleaning ${staleContainers.length} stale sandbox container(s)`);
    for (const container of staleContainers) {
      await killSandboxFamily(container);
      const gone = await waitForSandboxFamilyGone(container, 30_000);
      if (!gone) {
        console.warn(`smoke: sandbox family ${sandboxFamilyKey(container)} remained after cleanup`);
      }
    }
  }

  const baselineSandboxIds = new Set(
    (await listSandboxContainers()).map(container => container.id)
  );
  const results: LifecycleResult[] = [];
  for (const { lifecycle, conversation, api = 'unified' } of DEFAULT_MATRIX) {
    const scenarioFn = LIFECYCLE_SCENARIOS[lifecycle];
    if (!scenarioFn) {
      console.error(`smoke: unknown lifecycle ${lifecycle}`);
      continue;
    }
    console.log(`\n=== ${lifecycle}/${conversation} [api=${api}] ===`);
    const rowSessionIds = new Set<string>();
    const rowConfig: DriverConfig = {
      ...config,
      onSessionCreated: sessionId => rowSessionIds.add(sessionId),
    };
    let cleanupFailure: LifecycleResult | null = null;
    try {
      const result = await scenarioFn({ config: rowConfig, conversation, api });
      printResult(result);
      results.push(result);
    } finally {
      const cleanupStartedAt = Date.now();
      const cleanupErrors: string[] = [];
      for (const sessionId of rowSessionIds) {
        try {
          await cleanupSessionUntilSettled(rowConfig, sessionId);
        } catch (error) {
          cleanupErrors.push(
            `cleanup ${sessionId} threw: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
      try {
        const message = await cleanupMatrixSandboxes(baselineSandboxIds);
        if (message) cleanupErrors.push(message);
      } catch (error) {
        cleanupErrors.push(
          `sandbox cleanup threw: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      if (cleanupErrors.length > 0) {
        cleanupFailure = {
          name: 'matrix-cleanup',
          conversation: `${lifecycle}/${conversation}`,
          ok: false,
          message: cleanupErrors.join('; '),
          events: [],
          durationMs: Date.now() - cleanupStartedAt,
        };
      }
    }
    if (cleanupFailure) {
      printResult(cleanupFailure);
      results.push(cleanupFailure);
      console.error(
        'smoke: stopping because the next row would inherit contaminated sandbox state'
      );
      break;
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
