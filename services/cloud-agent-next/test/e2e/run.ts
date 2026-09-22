/**
 * CLI entrypoint for running a single lifecycle × conversation pair.
 *
 * Usage:
 *   tsx test/e2e/run.ts [--api=unified|legacy] [--timeout-ms=<n>] <lifecycle> <conversation>
 *
 * Examples:
 *   tsx test/e2e/run.ts cold echo:hi
 *   tsx test/e2e/run.ts hot echo:hi
 *   tsx test/e2e/run.ts external-kill echo:hi
 *   tsx test/e2e/run.ts kill-mid-flight hang
 *   tsx test/e2e/run.ts queue-while-busy _
 *   tsx test/e2e/run.ts queue-overflow _
 *   tsx test/e2e/run.ts callback-completion echo:done
 *   tsx test/e2e/run.ts wrapper-freeze-settled-reap _
 *   tsx test/e2e/run.ts --api=legacy hot echo:hi
 *
 * The conversation is a per-scenario argument: a real directive for the turn
 * scenarios, a result label only where the scenario owns its own directive.
 *
 * The stack must be running (`pnpm dev:start cloud-agent`). Leave
 * `KILO_OPENROUTER_BASE` on Next.js and select `kilo/fake-deterministic`.
 * Prefix `WORKER_URL` / `FAKE_LLM_URL` from `pnpm dev:status --json` when
 * the session port offset is non-zero.
 *
 * `E2E_PROFILE=deployed` switches to the deployed profile: it never loads
 * `.dev.vars`/root env files, never touches Postgres, and selects scenarios
 * from `SHARED_SCENARIOS` (see `test/e2e/README.md`). The default profile is
 * `local`.
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
import { DEFAULT_CONFIG, type ApiVersion, type DriverConfig } from './client.js';
import { bootstrapDeployedProfile, fetchStreamTicket, type DeployedAuth } from './deployed-auth.js';
import { isControlPlaneOwner, isWorktreeOwner } from '../../src/session-plane.js';
import type { LifecycleResult } from './lifecycle.js';
import { runSharedScenario, resolveScenarioApi } from './scenario-capabilities.js';
import { SHARED_SCENARIOS, type SharedScenario } from './scenarios-shared.js';
import { createLocalScenarioEnvironment } from './capabilities-local.js';
import { createDeployedScenarioEnvironment } from './capabilities-deployed.js';
import { createLocalHttpScenarioEnvironment } from './e2e-surface-client.js';

/**
 * Local runs that create a control-plane worktree session, so the driver owner
 * must be enrolled in `CONTROL_PLANE_IDS` and `WORKTREE_CREATION_ENABLED_IDS`.
 * Derived from the shared definitions' `requiresWorktreeCreation` flag, so a
 * converted scenario cannot silently skip the enrollment precheck.
 */
export const WORKTREE_ENROLLMENT_SCENARIOS: ReadonlySet<string> = new Set(
  Object.values(SHARED_SCENARIOS)
    .filter(definition => definition.requiresWorktreeCreation === true)
    .map(definition => definition.name)
);

/**
 * Every scenario either profile can dispatch, so `--timeout-ms` is accepted for
 * exactly the shared registry.
 */
const TIMEOUT_MS_SCENARIOS: ReadonlySet<string> = new Set(Object.keys(SHARED_SCENARIOS));

/**
 * Resolve the per-scenario timeout: an explicit request wins, otherwise the
 * definition's own default. The definition default is what gives an HTTP-only
 * run (`runLocalHttp` / `runDeployed`) the same budget the local profile gets.
 */
function timeoutRequestArgs(
  definition: SharedScenario,
  requestedTimeoutMs: number | undefined
): { timeoutMs?: number } {
  if (requestedTimeoutMs !== undefined) return { timeoutMs: requestedTimeoutMs };
  if (definition.defaultTimeoutMs !== undefined) return { timeoutMs: definition.defaultTimeoutMs };
  return {};
}

const SERVICE_PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** The one classification of a result: a pass, a failure, or unsupported. */
export type ResultOutcome = 'pass' | 'failure' | 'unsupported';

export function resultOutcome(result: LifecycleResult): ResultOutcome {
  if (result.ok) return 'pass';
  return result.unsupported === true ? 'unsupported' : 'failure';
}

const OUTCOME_ICON: Record<ResultOutcome, string> = {
  pass: '✅',
  failure: '❌',
  unsupported: '⚠️',
};

/** Single-scenario exit policy: unsupported 2, failure 1, pass 0. */
export function exitCodeFor(result: LifecycleResult): number {
  return exitCodeForResults([result]);
}

/**
 * Aggregate exit policy over a matrix: `1` when any scenario failed, else `2`
 * when any unsupported is not an expected capability gap, else `0` (including
 * an empty set). `expectedUnsupported` is derived by the caller from
 * `isScenarioSupported`, so a declared capability gap stays a reported
 * `unsupported` outcome without failing the matrix.
 */
export function exitCodeForResults(
  results: readonly LifecycleResult[],
  opts: { expectedUnsupported?: ReadonlySet<string> } = {}
): number {
  if (results.some(result => resultOutcome(result) === 'failure')) return 1;
  const expected = opts.expectedUnsupported ?? new Set<string>();
  if (
    results.some(result => resultOutcome(result) === 'unsupported' && !expected.has(result.name))
  ) {
    return 2;
  }
  return 0;
}

/**
 * CLI plumbing shared by the single-scenario driver and the matrix runners
 * around the one API decision (`resolveScenarioApi`): a conflicting explicit
 * selection is a configuration error, never a silent transport switch.
 */
export function requireScenarioApi(
  def: { name: string; defaultApi?: ApiVersion },
  requested: ApiVersion | undefined
): ApiVersion {
  const resolved = resolveScenarioApi(def, requested);
  if (!resolved.ok) {
    console.error(resolved.message);
    process.exit(2);
  }
  return resolved.api;
}

function printUsage(): void {
  const scenarios = Object.keys(SHARED_SCENARIOS).join('|');
  console.error(
    `Usage: tsx test/e2e/run.ts [--api=unified|legacy] [--verbose] [--timeout-ms=<n>] <${scenarios}> <conversation>`
  );
  console.error('');
  console.error('conversation format: <scenario>[:<arg1>[:<arg2>...]]');
  console.error('examples: echo:hi | gate:tag | error:boom | slow:5:200 | hang | idle');
  console.error('');
  console.error('queue flows ignore <conversation> for their directive; pass `_` as placeholder.');
  console.error('');
  console.error('--verbose  dump every received stream event (type + compact data)');
  console.error('--timeout-ms=<n>  positive integer scenario deadline');
  console.error('  per-turn deadline for cold-hot');
  console.error('');
  console.error(
    'E2E_PROFILE=deployed selects the deployed profile (unified API, except scenarios that pin the legacy prepare flow).'
  );
  console.error(
    'Scenarios that require a local-only capability report unsupported on profiles that lack it.'
  );
}

/**
 * Parse `[--api=...] [--verbose] [--timeout-ms=...] <lifecycle> <conversation>` from argv.
 * Returns null on malformed input so the caller can print usage and exit.
 * `api` is absent unless `--api=` was given, so the shared resolver — not a
 * local default — decides the surface (and enforces a definition's pin).
 */
export function parseArgs(argv: string[]): {
  api?: ApiVersion;
  lifecycle: string;
  conversation: string;
  verbose: boolean;
  timeoutMs?: number;
} | null {
  let api: ApiVersion | undefined;
  let verbose = false;
  let timeoutMs: number | undefined;
  const positional: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith('--api=')) {
      const value = arg.slice('--api='.length);
      if (value !== 'unified' && value !== 'legacy') {
        console.error(`invalid --api value: ${value}`);
        return null;
      }
      api = value;
      continue;
    }
    if (arg === '--verbose' || arg === '-v') {
      verbose = true;
      continue;
    }
    if (arg.startsWith('--timeout-ms=')) {
      const value = Number(arg.slice('--timeout-ms='.length));
      if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
        console.error(`invalid --timeout-ms value: ${arg.slice('--timeout-ms='.length)}`);
        return null;
      }
      timeoutMs = value;
      continue;
    }
    positional.push(arg);
  }
  const [lifecycle, conversation] = positional;
  if (!lifecycle || !conversation) return null;
  if (timeoutMs !== undefined && !TIMEOUT_MS_SCENARIOS.has(lifecycle)) {
    console.error(`--timeout-ms is only supported for: ${[...TIMEOUT_MS_SCENARIOS].join(', ')}`);
    return null;
  }
  return {
    ...(api !== undefined ? { api } : {}),
    lifecycle,
    conversation,
    verbose,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}

/**
 * Pretty-print a result. Includes a compact event summary so triage doesn't
 * require grepping logs. When `verbose` is true, every event is dumped with
 * a trimmed data preview so each scenario can be inspected step by step.
 */
export function printResult(result: LifecycleResult, opts?: { verbose?: boolean }): void {
  const outcome = resultOutcome(result);
  console.log(
    `${OUTCOME_ICON[outcome]} ${result.name}/${result.conversation} (${result.durationMs}ms): ${result.message}`
  );
  const showEvents = opts?.verbose === true || outcome !== 'pass';
  if (!showEvents) return;
  const byType: Record<string, number> = {};
  for (const event of result.events) {
    byType[event.streamEventType] = (byType[event.streamEventType] ?? 0) + 1;
  }
  const summary = Object.entries(byType)
    .map(([type, count]) => `${type}×${count}`)
    .join(' ');
  console.log(`   events (${result.events.length}): ${summary || '(none)'}`);
  if (!opts?.verbose) return;
  for (const event of result.events) {
    const preview = previewEventData(event.data);
    console.log(`   [${event.eventId}] ${event.streamEventType} ${preview}`);
  }
}

/**
 * Render a one-line preview of an event's `data` field. Strips noisy fields
 * (stacks, nested `info` bodies) and truncates long strings so a verbose run
 * remains readable on a terminal.
 */
function previewEventData(data: Record<string, unknown>): string {
  if (!data || typeof data !== 'object') return '';
  const pairs: string[] = [];
  for (const key of [
    'type',
    'messageId',
    'sessionId',
    'status',
    'delivery',
    'accepted',
    'step',
    'action',
  ]) {
    const value = data[key];
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean')
      continue;
    const rendered = typeof value === 'string' ? JSON.stringify(value.slice(0, 80)) : String(value);
    pairs.push(`${key}=${rendered}`);
  }
  return pairs.join(' ');
}

type ParsedArgs = NonNullable<ReturnType<typeof parseArgs>>;

/**
 * Resolve `E2E_PROFILE`. Unset/empty/whitespace and `local` select the local
 * profile; `deployed` selects the deployed profile. Any other value is a
 * configuration error rather than a silent fallback.
 */
function resolveProfile(): 'local' | 'deployed' {
  const raw = process.env.E2E_PROFILE;
  const value = raw?.trim() ?? '';
  if (value === '' || value === 'local') return 'local';
  if (value === 'deployed') return 'deployed';
  console.error(`invalid E2E_PROFILE: ${raw} (expected "local" or "deployed")`);
  printUsage();
  process.exit(2);
}

async function runLocal(parsed: ParsedArgs): Promise<void> {
  if (process.env.E2E_LOCAL_HTTP === '1') {
    await runLocalHttp(parsed);
    return;
  }
  const { lifecycle, conversation, verbose, timeoutMs: requestedTimeoutMs } = parsed;
  const definition = SHARED_SCENARIOS[lifecycle];
  if (!definition) {
    console.error(`Unknown lifecycle: ${lifecycle}`);
    printUsage();
    process.exit(2);
  }
  const api = requireScenarioApi(definition, parsed.api);

  loadRepoEnvFiles(SERVICE_PACKAGE_DIR);
  const devVars = loadDevVars(SERVICE_PACKAGE_DIR);
  const seededEmail = process.env.E2E_USER_EMAIL?.trim();
  const email = seededEmail ?? `kilo-e2e-driver-${Date.now()}${DRIVER_USER_EMAIL_SUFFIX}`;
  const user = seededEmail
    ? await loadExistingUserByEmail(process.env.DATABASE_URL, seededEmail)
    : await ensureTestUser(process.env.DATABASE_URL, email, {
        funded: process.env.E2E_FUNDED === '1',
      });
  const expectControlPlane = Boolean(devVars.CONTROL_PLANE_IDS?.trim());
  const requiresWorktreeEnrollment = WORKTREE_ENROLLMENT_SCENARIOS.has(lifecycle);
  if (
    requiresWorktreeEnrollment &&
    (!isControlPlaneOwner(devVars, { userId: user.id }) ||
      !isWorktreeOwner(devVars, { userId: user.id }))
  ) {
    throw new Error(
      `${lifecycle} requires the E2E user to be enrolled in CONTROL_PLANE_IDS and WORKTREE_CREATION_ENABLED_IDS ` +
        'in the Worker .dev.vars; no session was started'
    );
  }
  if (expectControlPlane && !isControlPlaneOwner(devVars, { userId: user.id })) {
    throw new Error('The E2E user is not enrolled in CONTROL_PLANE_IDS; no session was started');
  }
  console.log(
    `driver user: ${user.id} (${user.email}); api=${api}; controlPlane=${expectControlPlane}`
  );

  const config: DriverConfig = {
    ...DEFAULT_CONFIG,
    user,
    nextAuthSecret: devVars.NEXTAUTH_SECRET ?? '',
    internalApiSecret: devVars.INTERNAL_API_SECRET,
    workerUrl: process.env.WORKER_URL ?? DEFAULT_CONFIG.workerUrl,
    fakeLlmUrl: process.env.FAKE_LLM_URL ?? DEFAULT_CONFIG.fakeLlmUrl,
    expectControlPlane,
    gitUrl: process.env.E2E_GIT_URL ?? DEFAULT_CONFIG.gitUrl,
    ...(process.env.E2E_GITHUB_REPO ? { githubRepo: process.env.E2E_GITHUB_REPO } : {}),
    ...(process.env.E2E_BRANCH ? { branch: process.env.E2E_BRANCH } : {}),
    model: process.env.E2E_MODEL ?? DEFAULT_CONFIG.model,
  };

  const result = await runSharedScenario(definition, {
    config,
    conversation,
    api,
    env: createLocalScenarioEnvironment(),
    ...timeoutRequestArgs(definition, requestedTimeoutMs),
  });
  printResult(result, { verbose });
  process.exit(exitCodeFor(result));
}

type DeployedProfileEnv = ReturnType<typeof bootstrapDeployedProfile>;

/**
 * `E2E_LOCAL_HTTP=1`: the local Worker and its public tunnels, driven with the
 * deployed-style auth composition (a real personal token plus backend stream
 * tickets) and the HTTP-only capability set. There is no Docker fallback, so it
 * dispatches only from `SHARED_SCENARIOS`.
 */
async function runLocalHttp(parsed: ParsedArgs): Promise<void> {
  const { lifecycle, conversation, verbose, timeoutMs } = parsed;
  const definition = SHARED_SCENARIOS[lifecycle];
  if (!definition) {
    console.error(
      `${lifecycle} is not a shared scenario; E2E_LOCAL_HTTP=1 supports: ` +
        Object.keys(SHARED_SCENARIOS).join(', ')
    );
    process.exit(2);
  }
  const api = requireScenarioApi(definition, parsed.api);
  if (parsed.api === 'legacy' && definition.defaultApi !== 'legacy') {
    console.error(
      'E2E_LOCAL_HTTP=1 supports the unified API only; rerun without --api=legacy. ' +
        '(Scenarios that pin the legacy prepare flow select it themselves.)'
    );
    process.exit(2);
  }

  const env = bootstrapDeployedProfile();
  const auth = env.auth;
  const config = buildDeployedConfig(env, auth, {
    ...(process.env.E2E_GIT_URL ? { gitUrl: process.env.E2E_GIT_URL } : {}),
    ...(process.env.E2E_MODEL ? { model: process.env.E2E_MODEL } : {}),
  });

  const result = await runSharedScenario(definition, {
    config,
    conversation,
    api,
    env: createLocalHttpScenarioEnvironment({
      surfaceUrl: config.workerUrl,
      bearerToken: auth.token,
      internalApiSecret: config.internalApiSecret,
    }),
    ...timeoutRequestArgs(definition, timeoutMs),
  });
  printResult(result, { verbose });
  process.exit(exitCodeFor(result));
}

/**
 * Build the deployed-profile driver config from the validated env and auth.
 * Pure: every input is an argument, so it is unit-testable without process env.
 * It deliberately omits `expectControlPlane` and `nextAuthSecret`; the scenario
 * owns the `workspace_*` assertion so its `finally` can clean up even a
 * wrong-plane session.
 */
export function buildDeployedConfig(
  env: DeployedProfileEnv,
  auth: DeployedAuth,
  overrides: { gitUrl?: string; model?: string } = {}
): DriverConfig {
  return {
    ...DEFAULT_CONFIG,
    user: {
      id: auth.identity.userId,
      ...(auth.identity.email === undefined ? {} : { email: auth.identity.email }),
    },
    bearerToken: auth.token,
    fetchStreamTicket: sessionId =>
      fetchStreamTicket({ backendUrl: env.backendUrl, token: auth.token, sessionId }),
    skipBalanceCheck: false,
    workerUrl: env.workerUrl,
    internalApiSecret: env.e2eInternalApiSecret,
    fakeLlmUrl: env.fakeLlmUrl,
    gitUrl: overrides.gitUrl ?? DEFAULT_CONFIG.gitUrl,
    model: overrides.model ?? DEFAULT_CONFIG.model,
  };
}

/**
 * Deployed profile. Never loads `.dev.vars`/root env files, never touches
 * Postgres, and never mints JWTs or stream tickets: it authenticates with a
 * real personal API token from the auth file and fetches tickets from the live
 * backend. It dispatches only from `SHARED_SCENARIOS`.
 */
async function runDeployed(parsed: ParsedArgs): Promise<void> {
  const { lifecycle, conversation, verbose, timeoutMs } = parsed;
  const definition = SHARED_SCENARIOS[lifecycle];
  if (!definition) {
    console.error(`Unknown lifecycle: ${lifecycle}`);
    printUsage();
    process.exit(2);
  }
  const api = requireScenarioApi(definition, parsed.api);
  if (parsed.api === 'legacy' && definition.defaultApi !== 'legacy') {
    console.error(
      'The deployed profile supports the unified API only; rerun without --api=legacy. ' +
        '(Scenarios that pin the legacy prepare flow select it themselves.)'
    );
    process.exit(2);
  }

  const env = bootstrapDeployedProfile();
  const auth = env.auth;
  const config = buildDeployedConfig(env, auth, {
    ...(process.env.E2E_GIT_URL ? { gitUrl: process.env.E2E_GIT_URL } : {}),
    ...(process.env.E2E_MODEL ? { model: process.env.E2E_MODEL } : {}),
  });

  const result = await runSharedScenario(definition, {
    config,
    conversation,
    api,
    env: createDeployedScenarioEnvironment({
      surfaceUrl: config.workerUrl,
      bearerToken: auth.token,
      internalApiSecret: config.internalApiSecret,
    }),
    ...timeoutRequestArgs(definition, timeoutMs),
  });
  printResult(result, { verbose });
  process.exit(exitCodeFor(result));
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed) {
    printUsage();
    process.exit(2);
  }
  if (resolveProfile() === 'deployed') {
    await runDeployed(parsed);
    return;
  }
  await runLocal(parsed);
}

// Only run as a CLI when this file is executed directly. `smoke.ts` imports
// `printResult` from here, and without this guard `main()` would fire at
// module-load time and kill the smoke matrix before it starts.
const invokedDirectly = process.argv[1]
  ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
  : false;
if (invokedDirectly) {
  main().catch(err => {
    console.error('driver failed:', err);
    process.exit(1);
  });
}
