import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  templateReferences,
  type ManifestRow,
  type SeedMap,
  type SeedValue,
} from './batch-manifest';

/**
 * Every seed topic the batch manifest needs, in the order they must run, keyed
 * by the step name a `{{seed:<step>.<key>}}` link template names. Each topic
 * prints its ids with `--json`, so the map never reads the database itself.
 * Order matters: the reviewer analytics topic seeds the organizations the
 * account-pair topic created, and every topic needs the signed-in account.
 * `sessions` also needs the account's GitHub integration on the fixture
 * installation (`app:github-integration`, which validates against GitHub with
 * the app credentials); without it that step fails and only its links go
 * unresolved.
 */
export const SEED_STEPS: readonly Readonly<{
  step: string;
  topic: string;
  args: (email: string) => string[];
}>[] = [
  { step: 'org-pair', topic: 'app:mobile-org-account-pair', args: email => [email] },
  { step: 'reviewer-analytics', topic: 'app:mobile-reviewer-analytics', args: email => [email] },
  { step: 'profile-caps', topic: 'app:mobile-profile-caps', args: email => ['--email', email] },
  { step: 'security-findings', topic: 'app:security-agent-findings', args: email => [email] },
  {
    step: 'security-org-scopes',
    topic: 'app:mobile-security-agent-notification-scopes',
    args: email => [email],
  },
  {
    step: 'review-list',
    topic: 'code-reviews:review-list',
    args: email => ['--email', email, '--count', '60'],
  },
  {
    step: 'sessions',
    topic: 'app:mobile-sheet-fixtures',
    args: email => [email, '--child-performance'],
  },
  { step: 'paged-history', topic: 'app:paged-history', args: email => [email] },
  { step: 'session-diff', topic: 'app:mobile-session-diff-fixture', args: email => [email] },
];

export type SeedRunner = (
  topic: string,
  args: readonly string[]
) => {
  status: number | null;
  stdout: string;
  stderr: string;
};

export function pnpmSeedRunner(repo: string): SeedRunner {
  return (topic, args) => {
    const result = spawnSync('pnpm', ['-s', 'dev:seed', topic, ...args, '--json'], {
      cwd: repo,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };
}

function parseSeedJson(stdout: string): Record<string, SeedValue> {
  const line = stdout
    .split('\n')
    .map(entry => entry.trim())
    .filter(entry => entry.startsWith('{'))
    .at(-1);
  if (line === undefined) throw new Error('the topic printed no JSON line');
  const parsed: unknown = JSON.parse(line);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('the topic printed JSON that is not an object');
  }
  const values: Record<string, SeedValue> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      values[key] = value as SeedValue;
    }
  }
  return values;
}

/** The steps the given rows reference, in `SEED_STEPS` order. */
export function stepsFor(rows: readonly ManifestRow[]): string[] {
  const named = new Set(
    rows.flatMap(row =>
      templateReferences(row.link).map(reference => /^seed:([a-z0-9-]+)\./.exec(reference)?.[1])
    )
  );
  return SEED_STEPS.map(entry => entry.step).filter(step => named.has(step));
}

/**
 * Runs every seed step for one fake account and returns the id map. A failed
 * step is recorded with its error and the next steps still run, so one missing
 * service costs only the links that reference that step.
 */
export function seedAll(options: {
  email: string;
  steps?: readonly string[];
  run: SeedRunner;
  log: (line: string) => void;
}): SeedMap {
  if (!/@example\.com$/i.test(options.email)) {
    throw new Error(`seed-all seeds fake accounts only (@example.com), got ${options.email}`);
  }
  const wanted = options.steps ?? SEED_STEPS.map(entry => entry.step);
  const unknown = wanted.filter(step => !SEED_STEPS.some(entry => entry.step === step));
  if (unknown.length > 0) throw new Error(`unknown seed step(s): ${unknown.join(', ')}`);
  const steps: Record<string, SeedMap['steps'][string]> = {};
  for (const entry of SEED_STEPS.filter(candidate => wanted.includes(candidate.step))) {
    const result = options.run(entry.topic, entry.args(options.email));
    try {
      if (result.status !== 0) {
        const reason = result.stderr
          .split('\n')
          .map(line => line.trim())
          .filter(line => line !== '' && !line.startsWith('at '));
        throw new Error(`exit ${result.status}: ${reason.slice(-2).join(' | ')}`);
      }
      const values = parseSeedJson(result.stdout);
      steps[entry.step] = { topic: entry.topic, ok: true, values };
      options.log(
        `seed-all: ${entry.step} (${entry.topic}) ok: ${Object.keys(values).length} values`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      steps[entry.step] = { topic: entry.topic, ok: false, values: {}, error: message };
      options.log(`seed-all: ${entry.step} (${entry.topic}) FAILED: ${message}`);
    }
  }
  return { email: options.email, createdAt: new Date().toISOString(), steps };
}

export function readSeedMap(file: string): SeedMap {
  const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('steps' in parsed) ||
    typeof parsed.steps !== 'object' ||
    parsed.steps === null
  ) {
    throw new Error(`${file} is not a seed-all map`);
  }
  return parsed as SeedMap;
}

export function writeSeedMap(file: string, map: SeedMap): void {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(map, null, 2)}\n`);
}
