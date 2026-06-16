import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PROJECTS,
  confirm,
  listVariables,
  pullValue,
  resolveVault,
  resolveVercelContexts,
  setVariable,
  setVaultValue,
} from './shared.js';

async function main(): Promise<void> {
  if (
    !(await confirm('Backfill readable Production secrets into 1Password and mark them sensitive?'))
  ) {
    console.log('Cancelled.');
    return;
  }

  const tempDirectory = mkdtempSync(path.join(os.tmpdir(), 'kilo-web-env-backfill-'));
  const migrated: string[] = [];
  const unresolved: string[] = [];
  const skipped: string[] = [];

  try {
    const contexts = resolveVercelContexts(tempDirectory);
    const vaultId = resolveVault();
    const production = contexts.map(context => listVariables(context, 'production'));
    const names = [...new Set(production.flatMap(variables => [...variables.keys()]))].sort();

    for (const name of names) {
      const types = production.map(variables => variables.get(name));
      if (types.includes('system')) continue;
      if (types.some(type => !type) || types.includes('sensitive')) {
        unresolved.push(`${name} (missing or already sensitive)`);
        continue;
      }
      if (!(await confirm(`Treat ${name} as a secret?`))) {
        skipped.push(name);
        continue;
      }

      const productionValues = contexts.map(context => pullValue(context, 'production', name));
      if (!productionValues[0] || productionValues.some(value => value !== productionValues[0])) {
        unresolved.push(`${name} (Production values differ)`);
        continue;
      }

      const stagingTypes = contexts.map(context => listVariables(context, 'staging').get(name));
      let stagingValue: string | undefined;
      if (stagingTypes.every(type => type === 'sensitive')) {
        stagingValue = undefined;
      } else {
        const stagingValues = contexts.map(context => pullValue(context, 'staging', name));
        if (!stagingValues[0] || stagingValues.some(value => value !== stagingValues[0])) {
          unresolved.push(`${name} (Staging values differ or are unavailable)`);
          continue;
        }
        stagingValue = stagingValues[0];
      }

      console.log(`Migrating ${name}...`);
      setVaultValue(vaultId, name, productionValues[0]);
      for (const context of contexts) {
        setVariable(context, 'production', name, productionValues[0], true);
      }
      if (stagingValue) {
        for (const context of contexts) setVariable(context, 'staging', name, stagingValue, true);
      }
      migrated.push(name);
    }
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true });
    console.log('\nMigrated:');
    console.log(migrated.length ? migrated.map(name => `- ${name}`).join('\n') : '- None');
    console.log('\nUnresolved:');
    console.log(unresolved.length ? unresolved.map(name => `- ${name}`).join('\n') : '- None');
    console.log('\nSkipped:');
    console.log(skipped.length ? skipped.map(name => `- ${name}`).join('\n') : '- None');
    console.log(`\nProjects checked: ${PROJECTS.join(', ')}`);
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Backfill failed.');
  process.exitCode = 1;
});
