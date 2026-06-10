/**
 * CLI entrypoint for running a single lifecycle × conversation pair.
 *
 * Usage:
 *   tsx test/e2e/run.ts [--api=unified|legacy] <lifecycle> <conversation>
 *
 * Examples:
 *   tsx test/e2e/run.ts cold echo:hi
 *   tsx test/e2e/run.ts hot echo:hi
 *   tsx test/e2e/run.ts external-kill echo:hi
 *   tsx test/e2e/run.ts kill-mid-flight hang
 *   tsx test/e2e/run.ts queue-while-busy gate1
 *   tsx test/e2e/run.ts queue-overflow _
 *   tsx test/e2e/run.ts callback-completion echo:done
 *   tsx test/e2e/run.ts --api=legacy hot echo:hi
 *
 * The stack must be running with `.dev.vars` pointing
 * `KILO_OPENROUTER_BASE` at `http://localhost:<8811 + portOffset>/api`
 * and the `fake-llm` dev service started (`pnpm dev:start cloud-agent fake-llm`).
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureTestUser, loadDevVars, loadRepoEnvFiles, DRIVER_USER_EMAIL_SUFFIX } from './auth.js';
import { DEFAULT_CONFIG, type ApiVersion, type DriverConfig } from './client.js';
import {
  LIFECYCLE_SCENARIOS,
  type ConversationScenario,
  type LifecycleResult,
} from './lifecycle.js';

const SERVICE_PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function printUsage(): void {
  const scenarios = Object.keys(LIFECYCLE_SCENARIOS).join('|');
  console.error(
    `Usage: tsx test/e2e/run.ts [--api=unified|legacy] [--verbose] <${scenarios}> <conversation>`
  );
  console.error('');
  console.error('conversation format: <scenario>[:<arg1>[:<arg2>...]]');
  console.error('examples: echo:hi | gate:tag | error:boom | slow:5:200 | hang | idle');
  console.error('');
  console.error('queue flows ignore <conversation> for their directive; pass `_` as placeholder.');
  console.error('');
  console.error('--verbose  dump every received stream event (type + compact data)');
}

/**
 * Parse `[--api=...] [--verbose] <lifecycle> <conversation>` from argv.
 * Returns null on malformed input so the caller can print usage and exit.
 */
function parseArgs(argv: string[]): {
  api: ApiVersion;
  lifecycle: string;
  conversation: string;
  verbose: boolean;
} | null {
  let api: ApiVersion = 'unified';
  let verbose = false;
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
    positional.push(arg);
  }
  const [lifecycle, conversation] = positional;
  if (!lifecycle || !conversation) return null;
  return { api, lifecycle, conversation, verbose };
}

/**
 * Pretty-print a result. Includes a compact event summary so triage doesn't
 * require grepping logs. When `verbose` is true, every event is dumped with
 * a trimmed data preview so each scenario can be inspected step by step.
 */
export function printResult(result: LifecycleResult, opts?: { verbose?: boolean }): void {
  const icon = result.ok ? '✅' : '❌';
  console.log(
    `${icon} ${result.name}/${result.conversation} (${result.durationMs}ms): ${result.message}`
  );
  const showEvents = opts?.verbose === true || !result.ok;
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
  for (const [key, value] of Object.entries(data)) {
    if (key === 'stack' || key === 'info') continue;
    let rendered: string;
    if (value === null || value === undefined) {
      rendered = String(value);
    } else if (typeof value === 'string') {
      rendered =
        value.length > 60 ? JSON.stringify(value.slice(0, 57) + '…') : JSON.stringify(value);
    } else if (typeof value === 'object') {
      const json = JSON.stringify(value);
      rendered = json.length > 80 ? json.slice(0, 77) + '…' : json;
    } else {
      rendered = String(value);
    }
    pairs.push(`${key}=${rendered}`);
  }
  return pairs.join(' ');
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed) {
    printUsage();
    process.exit(2);
  }
  const { api, lifecycle, conversation, verbose } = parsed;
  const scenario = LIFECYCLE_SCENARIOS[lifecycle];
  if (!scenario) {
    console.error(`Unknown lifecycle: ${lifecycle}`);
    printUsage();
    process.exit(2);
  }

  loadRepoEnvFiles(SERVICE_PACKAGE_DIR);
  const devVars = loadDevVars(SERVICE_PACKAGE_DIR);
  const email = `kilo-e2e-driver-${Date.now()}${DRIVER_USER_EMAIL_SUFFIX}`;
  const user = await ensureTestUser(process.env.DATABASE_URL, email);
  console.log(`driver user: ${user.id} (${user.email}); api=${api}`);

  const config: DriverConfig = {
    ...DEFAULT_CONFIG,
    user,
    nextAuthSecret: devVars.NEXTAUTH_SECRET ?? '',
    internalApiSecret: devVars.INTERNAL_API_SECRET,
    workerUrl: process.env.WORKER_URL ?? DEFAULT_CONFIG.workerUrl,
    gitUrl: process.env.E2E_GIT_URL ?? DEFAULT_CONFIG.gitUrl,
    model: process.env.E2E_MODEL ?? DEFAULT_CONFIG.model,
  };

  const result = await scenario({
    config,
    conversation: conversation as ConversationScenario,
    api,
  });
  printResult(result, { verbose });
  process.exit(result.ok ? 0 : 1);
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
