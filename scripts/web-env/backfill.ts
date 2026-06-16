import { chmod, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBackfillReport, formatBackfillReport } from './backfill-report.js';
import { executeCommand } from './command.js';
import { OnePasswordAdapter } from './onepassword.js';
import { createTerminalPrompts } from './prompts.js';
import { WEB_ENV_PROJECTS, type VariableMetadata } from './plan.js';
import { VercelAdapter } from './vercel.js';

function byKey(variables: VariableMetadata[]): Map<string, VariableMetadata> {
  return new Map(variables.map(variable => [variable.key, variable]));
}

async function main(): Promise<void> {
  const confirmed = await createTerminalPrompts().confirm(
    'This temporary migration changes production and staging Vercel metadata. Continue?'
  );
  if (!confirmed) {
    console.log('Cancelled.');
    return;
  }

  const prompts = createTerminalPrompts();
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'kilo-web-env-backfill-'));
  await chmod(tempRoot, 0o700);
  const vercel = new VercelAdapter(executeCommand, tempRoot);
  const onePassword = new OnePasswordAdapter(executeCommand);
  const report = createBackfillReport();

  try {
    await vercel.initialize();
    await onePassword.initialize();

    const appProduction = byKey(await vercel.listVariables('kilocode-app', 'production'));
    const globalProduction = byKey(await vercel.listVariables('kilocode-global-app', 'production'));
    const names = [...new Set([...appProduction.keys(), ...globalProduction.keys()])].sort();

    for (const variableName of names) {
      const appMetadata = appProduction.get(variableName);
      const globalMetadata = globalProduction.get(variableName);
      if (appMetadata?.type === 'system' || globalMetadata?.type === 'system') continue;
      if (!appMetadata || !globalMetadata) {
        report.productionMismatches.push(variableName);
        continue;
      }
      if (appMetadata.type === 'sensitive' && globalMetadata.type === 'sensitive') {
        report.alreadySensitive.push(variableName);
        continue;
      }
      if (appMetadata.type === 'sensitive' || globalMetadata.type === 'sensitive') {
        report.productionMismatches.push(variableName);
        continue;
      }

      let mutationStarted = false;
      let activeOperation = 'read-only discovery';
      const completedOperations: string[] = [];
      let plannedOperations: string[] = [];
      try {
        const appProductionValue = await vercel.pullReadableValue(
          'kilocode-app',
          'production',
          variableName
        );
        const globalProductionValue = await vercel.pullReadableValue(
          'kilocode-global-app',
          'production',
          variableName
        );
        if (
          appProductionValue === undefined ||
          globalProductionValue === undefined ||
          appProductionValue !== globalProductionValue
        ) {
          report.productionMismatches.push(variableName);
          continue;
        }

        const isSecret = await prompts.confirm(`Store ${variableName} as a production secret?`);
        if (!isSecret) {
          report.skipped.push(variableName);
          continue;
        }

        const appStaging = await vercel.getVariable('kilocode-app', 'staging', variableName);
        const globalStaging = await vercel.getVariable(
          'kilocode-global-app',
          'staging',
          variableName
        );
        let stagingValue: string | undefined;
        const stagingAlreadySensitive =
          appStaging?.type === 'sensitive' && globalStaging?.type === 'sensitive';
        if (!stagingAlreadySensitive) {
          if (
            !appStaging ||
            !globalStaging ||
            appStaging.type === 'sensitive' ||
            globalStaging.type === 'sensitive'
          ) {
            report.stagingUnresolved.push(variableName);
            continue;
          }
          const appStagingValue = await vercel.pullReadableValue(
            'kilocode-app',
            'staging',
            variableName
          );
          const globalStagingValue = await vercel.pullReadableValue(
            'kilocode-global-app',
            'staging',
            variableName
          );
          if (
            appStagingValue === undefined ||
            globalStagingValue === undefined ||
            appStagingValue !== globalStagingValue
          ) {
            report.stagingUnresolved.push(variableName);
            continue;
          }
          stagingValue = appStagingValue;
        }

        if (await onePassword.findItem(variableName)) {
          report.failed.push(`${variableName} (1Password item already exists)`);
          continue;
        }

        plannedOperations = [
          '1Password',
          ...WEB_ENV_PROJECTS.map(project => `${project}/production`),
          ...(stagingValue === undefined
            ? []
            : WEB_ENV_PROJECTS.map(project => `${project}/staging`)),
        ];
        activeOperation = '1Password';
        mutationStarted = true;
        await onePassword.writeProductionValue('add', variableName, appProductionValue);
        completedOperations.push(activeOperation);

        for (const project of WEB_ENV_PROJECTS) {
          activeOperation = `${project}/production`;
          await vercel.writeVariable({
            mode: 'resume',
            project,
            environment: 'production',
            key: variableName,
            value: appProductionValue,
            sensitive: true,
            expectedType: 'sensitive',
          });
          completedOperations.push(activeOperation);
        }
        if (stagingValue !== undefined) {
          for (const project of WEB_ENV_PROJECTS) {
            activeOperation = `${project}/staging`;
            await vercel.writeVariable({
              mode: 'resume',
              project,
              environment: 'staging',
              key: variableName,
              value: stagingValue,
              sensitive: true,
              expectedType: 'sensitive',
            });
            completedOperations.push(activeOperation);
          }
        }
        report.migrated.push(variableName);
      } catch {
        if (!mutationStarted) {
          report.failed.push(variableName);
          continue;
        }
        const pending = plannedOperations.filter(
          operation => operation !== activeOperation && !completedOperations.includes(operation)
        );
        report.failed.push(
          `${variableName} (completed: ${completedOperations.join(', ') || 'none'}; failed: ${activeOperation}; pending: ${pending.join(', ') || 'none'})`
        );
        throw new Error(
          `Backfill stopped after a partial mutation of ${variableName}. Use the value-free report to reconcile it before retrying.`
        );
      }
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    console.log(`\n${formatBackfillReport(report, new Date().toISOString())}`);
  }
}

main().catch(error => {
  console.error(
    error instanceof Error ? error.message : 'Backfill failed. Provider output was redacted.'
  );
  process.exitCode = 1;
});
