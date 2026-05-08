// Must be the first import: it tweaks process.env based on argv (e.g. silences
// dotenv tips in --json mode) before any module-level side effects run.
import './lib/preflight';

import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { closeSeedDb } from './lib/db';

const JSON_FLAG = '--json';
const currentDir = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

export type SeedResultValue = string | number | boolean | null;
export type SeedResult = Record<string, SeedResultValue>;

type SeedModule = {
  run?: (...args: string[]) => Promise<SeedResult | void> | SeedResult | void;
  usage?: string;
};

function printSeedResult(scope: string, topic: string, result: SeedResult): void {
  const label = `${scope}:${topic}`;
  const entries = Object.entries(result);
  console.log('');
  console.log(`[${label}] Result:`);
  if (entries.length === 0) {
    console.log('  (no result fields)');
    return;
  }
  const keyWidth = Math.max(...entries.map(([key]) => key.length));
  for (const [key, value] of entries) {
    console.log(`  ${key.padEnd(keyWidth)}  ${value ?? 'null'}`);
  }
}

async function runWithSuppressedStdout<T>(fn: () => Promise<T>): Promise<T> {
  const originalLog = console.log;
  const originalInfo = console.info;
  const originalWarn = console.warn;
  const noop = (): void => {};
  console.log = noop;
  console.info = noop;
  console.warn = noop;
  try {
    return await fn();
  } finally {
    console.log = originalLog;
    console.info = originalInfo;
    console.warn = originalWarn;
  }
}

function listSeedScopes() {
  return readdirSync(currentDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name !== 'lib')
    .map(entry => entry.name)
    .sort();
}

function listTopics(scope: string): string[] {
  const scopeDir = join(currentDir, scope);
  return readdirSync(scopeDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.ts'))
    .map(entry => entry.name.replace(/\.ts$/, ''))
    .sort();
}

async function loadSeedModule(scope: string, topic: string): Promise<SeedModule> {
  const seedPath = join(currentDir, scope, `${topic}.ts`);
  return (await import(pathToFileURL(seedPath).href)) as SeedModule;
}

async function loadTopicUsage(scope: string, topic: string): Promise<string | null> {
  try {
    const seedModule = await loadSeedModule(scope, topic);
    return seedModule.usage ?? null;
  } catch {
    return null;
  }
}

async function printUsage() {
  const scopes = listSeedScopes();

  console.log('Usage: pnpm dev:seed <scope>:<topic> [args...]');
  console.log('       pnpm dev:seed <scope> <topic> [args...]');
  console.log('');
  console.log('Global flags:');
  console.log('  --json   Print only the result as a single JSON object on stdout.');
  console.log('           Combine with `pnpm -s` to also silence pnpm lifecycle banners,');
  console.log('           e.g. `pnpm -s dev:seed app:create-user "Foo" foo@example.com --json`.');
  console.log('');
  console.log('Available seed topics:');

  for (const scope of scopes) {
    console.log(`- ${scope}`);
    const topics = listTopics(scope);
    const usages = await Promise.all(topics.map(topic => loadTopicUsage(scope, topic)));
    for (const [index, topic] of topics.entries()) {
      const usage = usages[index];
      console.log(`  - ${scope}:${topic}${usage ? ` ${usage}` : ''}`);
    }
  }
}

function parseInvocation(
  rawArgs: string[]
): { scope: string; topic: string; topicArgs: string[] } | null {
  if (rawArgs.length === 0) return null;

  const [first, ...rest] = rawArgs;
  if (first.includes(':')) {
    const colonIndex = first.indexOf(':');
    const scope = first.slice(0, colonIndex);
    const topic = first.slice(colonIndex + 1);
    if (!scope || !topic) return null;
    return { scope, topic, topicArgs: rest };
  }

  if (rest.length === 0) return null;
  const [topic, ...topicArgs] = rest;
  return { scope: first, topic, topicArgs };
}

async function main() {
  const wantJson = args.includes(JSON_FLAG);
  const cleanedArgs = args.filter(arg => arg !== JSON_FLAG);

  const invocation = parseInvocation(cleanedArgs);
  if (!invocation) {
    await printUsage();
    process.exitCode = 1;
    return;
  }

  const { scope, topic, topicArgs } = invocation;
  const scopes = listSeedScopes();

  if (!scopes.includes(scope)) {
    console.error(`Unknown seed scope: ${scope}`);
    await printUsage();
    process.exitCode = 1;
    return;
  }

  const availableTopics = listTopics(scope);
  if (!availableTopics.includes(topic)) {
    console.error(`Unknown seed topic for ${scope}: ${topic}`);
    console.error(`Available topics: ${availableTopics.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const seedModule = await loadSeedModule(scope, topic);

  if (typeof seedModule.run !== 'function') {
    throw new Error(`Seed module ${scope}/${topic} does not export a run() function`);
  }

  const runSeed = seedModule.run;

  if (wantJson) {
    const result = await runWithSuppressedStdout(() => Promise.resolve(runSeed(...topicArgs)));
    process.stdout.write(`${JSON.stringify(result ?? null)}\n`);
    return;
  }

  const result = await runSeed(...topicArgs);
  if (result && typeof result === 'object') {
    printSeedResult(scope, topic, result);
  }
}

main()
  .catch(error => {
    console.error('Seed runner failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeSeedDb();
  });
