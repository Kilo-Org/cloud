import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const trustedRepository = 'Kilo-Org/cloud';
const mainRef = 'refs/heads/main';
const shaPattern = /^[a-f0-9]{40}$/;

/** Verify a manual request names a successful trusted CI push run on main. */
export function admitManualRuntimePublication({ sourceSha, ref, runs, workflow, repository }) {
  if (repository?.full_name !== trustedRepository)
    throw new Error('Untrusted publication repository');
  if (
    workflow?.name !== 'CI' ||
    workflow.path !== '.github/workflows/ci.yml' ||
    workflow.state !== 'active'
  )
    throw new Error('Untrusted CI workflow');
  if (ref !== mainRef) throw new Error('Manual publication requires the main branch');
  if (!shaPattern.test(sourceSha)) throw new Error('Manual publication requires an exact SHA');
  const admitted = runs.find(
    run =>
      Number.isSafeInteger(run.id) &&
      run.head_sha === sourceSha &&
      run.workflow_id === workflow.id &&
      run.path === workflow.path &&
      run.name === 'CI' &&
      run.event === 'push' &&
      run.head_branch === 'main' &&
      run.status === 'completed' &&
      run.conclusion === 'success' &&
      run.repository?.id === repository.id &&
      run.head_repository?.id === repository.id
  );
  if (!admitted) throw new Error('Manual publication requires a successful trusted main CI run');
  return sourceSha;
}

/** Read the CI workflow, repository and candidate successful main CI runs for one SHA. */
export async function readManualAdmissionMetadata(sourceSha, token, request = fetch) {
  if (!shaPattern.test(sourceSha)) throw new Error('Manual publication requires an exact SHA');
  const api = async endpoint => {
    const response = await request('https://api.github.com/repos/Kilo-Org/cloud' + endpoint, {
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error('CI admission metadata could not be verified');
    return response.json();
  };
  const [workflow, repository, list] = await Promise.all([
    api('/actions/workflows/ci.yml'),
    api(''),
    api(
      '/actions/workflows/ci.yml/runs?head_sha=' +
        sourceSha +
        '&event=push&status=success&per_page=10'
    ),
  ]);
  const candidates = Array.isArray(list.workflow_runs) ? list.workflow_runs : [];
  const runs = [];
  for (const candidate of candidates) {
    if (Number.isSafeInteger(candidate.id)) runs.push(await api('/actions/runs/' + candidate.id));
  }
  return { workflow, repository, runs };
}

async function main() {
  if (process.env.GITHUB_REPOSITORY !== trustedRepository)
    throw new Error('Untrusted publication repository');
  const sourceSha = process.env.SOURCE_SHA ?? '';
  const { workflow, repository, runs } = await readManualAdmissionMetadata(
    sourceSha,
    process.env.GITHUB_TOKEN
  );
  const sha = admitManualRuntimePublication({
    sourceSha,
    ref: process.env.GITHUB_REF,
    runs,
    workflow,
    repository,
  });
  await fs.appendFile(process.env.GITHUB_OUTPUT, 'source_sha=' + sha + '\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
