import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const cloudAgentRuntimePaths = [
  'services/cloud-agent-next',
  'packages',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'patches',
  'scripts/cloud-agent-runtime-changes.mjs',
  '.github/workflows/cloud-agent-runtime-admission.yml',
  '.github/workflows/cloud-agent-runtime-release.yml',
  '.github/workflows/deploy-workers.yml',
  '.github/workflows/deploy-production.yml',
];

export function cloudAgentRuntimeChanged(baseSha, sourceRef, workdir = process.cwd()) {
  if (!baseSha) return true;
  const compared = spawnSync(
    'git',
    ['diff', '--quiet', baseSha, sourceRef, '--', ...cloudAgentRuntimePaths],
    { cwd: workdir }
  );
  if (compared.status === 0) return false;
  if (compared.status === 1) return true;
  throw new Error(`Cannot compare Cloud Agent release inputs (git diff exit ${compared.status})`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4) throw new Error('Expected baseline SHA and source ref');
    console.log(cloudAgentRuntimeChanged(process.argv[2], process.argv[3]));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Cloud Agent change detection failed');
    process.exitCode = 1;
  }
}
