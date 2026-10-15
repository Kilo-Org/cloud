import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readSentryArtifact, runSentryCli, workerBuildArgs } from './sentry-source-maps.js';

const directory = resolve('dist/worker');
await rm(directory, { force: true, recursive: true });
await mkdir(directory, { recursive: true });
execFileSync(
  resolve('node_modules/.bin/wrangler'),
  workerBuildArgs(process.env.CLOUD_AGENT_DEPLOY_ENVIRONMENT),
  {
    stdio: 'inherit',
  }
);
runSentryCli(['sourcemaps', 'inject', directory]);
const artifact = await readSentryArtifact(directory, 'index.js');
await writeFile(resolve(directory, 'sentry-artifacts.json'), JSON.stringify([artifact], null, 2));
