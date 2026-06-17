import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PROJECTS,
  confirm,
  listVariables,
  pullValues,
  resolveVault,
  resolveVercelContexts,
  setVariable,
  setVaultValue,
} from './shared.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.some(argument => argument !== '--apply')) {
    throw new Error('Usage: tsx scripts/web-env/backfill.ts [--apply]');
  }
  const apply = args.includes('--apply');
  if (!apply) {
    console.log('DRY RUN: no 1Password or Vercel values will be changed.');
  }
  if (!(await confirm(`${apply ? 'Run' : 'Preview'} the Production secret backfill?`))) {
    console.log('Cancelled.');
    return;
  }

  const tempDirectory = mkdtempSync(path.join(os.tmpdir(), 'kilo-web-env-backfill-'));
  const migrated: string[] = [];
  const unresolved: string[] = [];
  const skipped: string[] = [];

  try {
    const contexts = resolveVercelContexts(tempDirectory);
    const vaultId = apply ? resolveVault() : undefined;
    const production = contexts.map(context => listVariables(context, 'production'));
    const productionValues = contexts.map(context => pullValues(context, 'production'));
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

      const projectProductionValues = productionValues.map(values => values.get(name));
      if (
        !projectProductionValues[0] ||
        projectProductionValues.some(value => value !== projectProductionValues[0])
      ) {
        unresolved.push(`${name} (Production values differ)`);
        continue;
      }

      console.log(
        `${apply ? 'Adding' : 'Would add'} ${name} to 1Password and mark Production sensitive...`
      );
      if (apply) {
        if (!vaultId) throw new Error('Could not resolve the 1Password vault.');
        setVaultValue(vaultId, name, projectProductionValues[0]);
        for (const context of contexts) {
          setVariable(context, 'production', name, projectProductionValues[0], true);
        }
      }
      migrated.push(name);
    }
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true });
    console.log(`\n${apply ? 'Migrated' : 'Would migrate'} Production secrets:`);
    console.log(migrated.length ? migrated.map(name => `- ${name}`).join('\n') : '- None');
    console.log('\nUnresolved:');
    console.log(unresolved.length ? unresolved.map(name => `- ${name}`).join('\n') : '- None');
    console.log('\nSkipped:');
    console.log(skipped.length ? skipped.map(name => `- ${name}`).join('\n') : '- None');
    console.log(`\nProjects checked: ${PROJECTS.join(', ')}`);
  }
  if (!apply) {
    console.log('\nDry run complete. Re-run with --apply to perform the migration.');
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Backfill failed.');
  process.exitCode = 1;
});
