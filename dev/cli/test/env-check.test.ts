import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Tests for envCheck that verify the final banner correctly reflects
 * the state of ALL checks, including .env.local and .vercel/project.json.
 *
 * To isolate the pre-requisite checks from per-service env checks, we
 * create all required service .dev.vars files (with valid content) in
 * the temp tree so the service loop doesn't contribute failures.
 */

// Import services to know which dirs need .dev.vars
import { services } from '../src/services/registry';
import { envCheck } from '../src/commands/env';

let root: string;
let logs: string[];
let errors: string[];
let origLog: typeof console.log;
let origError: typeof console.error;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'env-check-test-'));
  logs = [];
  errors = [];
  origLog = console.log;
  origError = console.error;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(' '));
});

afterEach(async () => {
  console.log = origLog;
  console.error = origError;
  await rm(root, { recursive: true, force: true });
});

function allOutput(): string {
  return [...logs, ...errors].join('\n');
}

/**
 * Creates all service .dev.vars AND their .dev.vars.example files so
 * that the per-service loop produces no warnings. The .dev.vars files
 * contain the same keys with non-placeholder values.
 */
async function createAllServiceEnvFiles() {
  const servicesWithEnv = services.filter(s => s.envFile);
  for (const svc of servicesWithEnv) {
    const dir = join(root, svc.dir);
    await mkdir(dir, { recursive: true });
    // Create example file with a non-placeholder value
    const exampleContent = 'SOME_KEY=real-value\n';
    await writeFile(join(dir, svc.envFile!), exampleContent);
    // Create actual .dev.vars with matching real value
    await writeFile(join(dir, '.dev.vars'), 'SOME_KEY=real-value\n');
  }
}

describe('envCheck final banner', () => {
  test('missing .env.local → banner should say "needs attention", not "passed"', async () => {
    // .env.local does NOT exist, .vercel/project.json DOES
    await mkdir(join(root, '.vercel'), { recursive: true });
    await writeFile(join(root, '.vercel', 'project.json'), '{}');
    await createAllServiceEnvFiles();

    await envCheck(root);

    const output = allOutput();
    expect(output).toContain('.env.local missing');
    expect(output).not.toContain('All environment checks passed');
    expect(output).toContain('Some checks need attention');
  });

  test('missing .vercel/project.json → banner should say "needs attention", not "passed"', async () => {
    // .env.local EXISTS, .vercel/project.json does NOT
    await writeFile(join(root, '.env.local'), 'KEY=value');
    await createAllServiceEnvFiles();

    await envCheck(root);

    const output = allOutput();
    expect(output).toContain('Vercel project not linked');
    expect(output).not.toContain('All environment checks passed');
    expect(output).toContain('Some checks need attention');
  });

  test('both prereqs missing → banner should say "needs attention"', async () => {
    await createAllServiceEnvFiles();

    await envCheck(root);

    const output = allOutput();
    expect(output).toContain('.env.local missing');
    expect(output).toContain('Vercel project not linked');
    expect(output).not.toContain('All environment checks passed');
    expect(output).toContain('Some checks need attention');
  });

  test('all prereqs present + all service envs OK → banner says "passed"', async () => {
    await writeFile(join(root, '.env.local'), 'KEY=value');
    await mkdir(join(root, '.vercel'), { recursive: true });
    await writeFile(join(root, '.vercel', 'project.json'), '{}');
    await createAllServiceEnvFiles();

    await envCheck(root);

    const output = allOutput();
    expect(output).toContain('All environment checks passed');
    expect(output).not.toContain('Some checks need attention');
  });
});
