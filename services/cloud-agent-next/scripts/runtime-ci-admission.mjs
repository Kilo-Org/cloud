import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export function admitRuntimePublication(event, run, workflow, repository) {
  const trigger = event.workflow_run;
  const trusted = 'Kilo-Org/cloud';
  if (
    event.repository?.full_name !== trusted ||
    repository.full_name !== trusted ||
    event.repository.id !== repository.id ||
    trigger?.id !== run.id ||
    trigger?.head_sha !== run.head_sha ||
    trigger?.workflow_id !== workflow.id ||
    run.workflow_id !== workflow.id ||
    run.repository?.id !== repository.id ||
    run.head_repository?.id !== repository.id ||
    trigger.head_repository?.id !== repository.id ||
    workflow.path !== '.github/workflows/ci.yml' ||
    workflow.name !== 'CI' ||
    workflow.state !== 'active' ||
    run.name !== 'CI' ||
    run.event !== 'push' ||
    trigger.event !== 'push' ||
    run.head_branch !== 'main' ||
    trigger.head_branch !== 'main' ||
    run.status !== 'completed' ||
    trigger.status !== 'completed' ||
    run.conclusion !== 'success' ||
    trigger.conclusion !== 'success' ||
    !/^[a-f0-9]{40}$/.test(run.head_sha)
  )
    throw new Error('Runtime publication requires successful trusted main-push CI');
  return run.head_sha;
}

/** Read the CI run, CI workflow and repository metadata that admission compares. */
export function readAdmissionMetadata(runId, token, request = fetch) {
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
  return Promise.all([api('/actions/runs/' + runId), api('/actions/workflows/ci.yml'), api('')]);
}

async function main() {
  if (process.env.GITHUB_REPOSITORY !== 'Kilo-Org/cloud')
    throw new Error('Untrusted publication repository');
  const event = JSON.parse(await fs.readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
  if (!Number.isSafeInteger(event.workflow_run?.id)) throw new Error('Invalid CI run ID');
  const [run, workflow, repository] = await readAdmissionMetadata(
    event.workflow_run.id,
    process.env.GITHUB_TOKEN
  );
  const sha = admitRuntimePublication(event, run, workflow, repository);
  await fs.appendFile(process.env.GITHUB_OUTPUT, 'source_sha=' + sha + '\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
