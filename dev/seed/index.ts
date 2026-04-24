import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { closeSeedDb } from './lib/db';

const currentDir = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

type SeedModule = {
  run?: (...args: string[]) => Promise<void> | void;
};

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

function printUsage() {
  const scopes = listSeedScopes();

  console.log('Usage: pnpm dev:seed <service|app> <topic>');
  console.log('');
  console.log('Available seed topics:');

  for (const scope of scopes) {
    console.log(`- ${scope}`);
    for (const topic of listTopics(scope)) {
      console.log(`  - ${topic}`);
    }
  }
}

async function main() {
  if (args.length < 2) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const [scope, topic, ...topicArgs] = args;
  const scopes = listSeedScopes();

  if (!scopes.includes(scope)) {
    console.error(`Unknown seed scope: ${scope}`);
    printUsage();
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

  const seedPath = join(currentDir, scope, `${topic}.ts`);
  const seedModule = (await import(pathToFileURL(seedPath).href)) as SeedModule;

  if (typeof seedModule.run !== 'function') {
    throw new Error(`Seed module ${scope}/${topic} does not export a run() function`);
  }

  await seedModule.run(...topicArgs);
}

main()
  .catch(error => {
    console.error('Seed runner failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeSeedDb();
  });
