import { z } from 'zod';

export const PUBLICATION_WORKFLOW = 'cloud-agent-runtime-publish.yml';
const CI_WORKFLOW = 'ci.yml';
const NO_RUN_GRACE_MS = 10 * 60_000;
const RUNS_PAGE_SIZE = 100;
const MAX_PUBLICATION_RUN_PAGES = 10;

/** Must match `run-name` in the publication workflow; the deploy finds its runs by this title. */
export const publicationRunTitle = (sourceSha: string) =>
  'Publish Cloud Agent runtime ' + sourceSha;

const publicationRunsSchema = z.object({
  workflow_runs: z.array(
    z.object({
      display_title: z.string(),
      head_branch: z.string().nullable(),
      status: z.string(),
      conclusion: z.string().nullable(),
      html_url: z.string(),
    })
  ),
});
export type PublicationRun = z.infer<typeof publicationRunsSchema>['workflow_runs'][number];

const ciRunsSchema = z.object({
  workflow_runs: z.array(
    z.object({
      status: z.string(),
      conclusion: z.string().nullable(),
      updated_at: z.string().datetime(),
    })
  ),
});
export type CiRun = z.infer<typeof ciRunsSchema>['workflow_runs'][number];

async function readWorkflowRuns(
  repository: string,
  token: string,
  workflow: string,
  query: string,
  request: typeof fetch
): Promise<unknown> {
  const response = await request(
    `https://api.github.com/repos/${repository}/actions/workflows/${workflow}/runs?${query}`,
    {
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(30_000),
    }
  );
  if (!response.ok) throw new Error(`${workflow} runs could not be read (${response.status})`);
  return response.json();
}

/**
 * Main publication runs titled for the SHA. A re-run keeps its original list position, so pages are
 * read until the list ends. Dispatches on other refs fail admission and never publish.
 */
export async function readPublicationRuns(
  sourceSha: string,
  repository: string,
  token: string,
  request: typeof fetch = fetch
): Promise<PublicationRun[]> {
  const title = publicationRunTitle(sourceSha);
  const matches: PublicationRun[] = [];
  for (let page = 1; page <= MAX_PUBLICATION_RUN_PAGES; page++) {
    const { workflow_runs: runs } = publicationRunsSchema.parse(
      await readWorkflowRuns(
        repository,
        token,
        PUBLICATION_WORKFLOW,
        `branch=main&per_page=${RUNS_PAGE_SIZE}&page=${page}`,
        request
      )
    );
    matches.push(...runs.filter(run => run.display_title === title && run.head_branch === 'main'));
    if (runs.length < RUNS_PAGE_SIZE) break;
  }
  return matches;
}

/** Main push CI runs for the SHA; only their success starts an automatic publication. */
export async function readCiRuns(
  sourceSha: string,
  repository: string,
  token: string,
  request: typeof fetch = fetch
): Promise<CiRun[]> {
  return ciRunsSchema.parse(
    await readWorkflowRuns(
      repository,
      token,
      CI_WORKFLOW,
      `head_sha=${sourceSha}&event=push&branch=main&per_page=10`,
      request
    )
  ).workflow_runs;
}

/** Skipped runs belong to unsuccessful CI attempts and never publish. */
const publicationAttempts = (runs: readonly PublicationRun[]) =>
  runs.filter(run => run.conclusion !== 'skipped');

/**
 * Explain why waiting for a missing handoff cannot succeed, or return null while it still can.
 * Any queued or running publication (including a re-run) keeps the deploy waiting. A publication
 * run starts only after main CI for the SHA succeeds, so queued or running CI keeps the deploy
 * waiting and the no-run grace counts from that success.
 */
export function publicationFailure(
  sourceSha: string,
  runs: readonly PublicationRun[],
  ciRuns: readonly CiRun[],
  waitedMs: number,
  now = Date.now()
): string | null {
  const attempts = publicationAttempts(runs);
  if (attempts.some(run => run.status !== 'completed')) return null;
  const retry = `Re-run publication with: gh workflow run ${PUBLICATION_WORKFLOW} --ref main -f source_sha=${sourceSha}`;
  if (attempts.length > 0) {
    const outcomes = attempts
      .map(run => `${run.conclusion ?? 'unknown'} ${run.html_url}`)
      .join(', ');
    return `Runtime publication for ${sourceSha} finished without a handoff (${outcomes}). ${retry}`;
  }
  if (ciRuns.some(run => run.status !== 'completed')) return null;
  const ciSuccesses = ciRuns
    .filter(run => run.conclusion === 'success')
    .map(run => Date.parse(run.updated_at));
  if (ciSuccesses.length === 0) {
    if (waitedMs < NO_RUN_GRACE_MS) return null;
    return `No successful main CI run exists for ${sourceSha}; runtime publication starts only after one succeeds.`;
  }
  if (now - Math.max(...ciSuccesses) < NO_RUN_GRACE_MS) return null;
  return `No runtime publication run for ${sourceSha} started within ${NO_RUN_GRACE_MS / 60_000} minutes of its CI succeeding. ${retry}`;
}

/** Read run state for the SHA. CI is read only while no publication attempt exists. */
export async function probePublication(
  sourceSha: string,
  repository: string,
  token: string,
  waitedMs: number,
  request: typeof fetch = fetch
): Promise<string | null> {
  const runs = await readPublicationRuns(sourceSha, repository, token, request);
  const ciRuns =
    publicationAttempts(runs).length > 0
      ? []
      : await readCiRuns(sourceSha, repository, token, request);
  return publicationFailure(sourceSha, runs, ciRuns, waitedMs);
}
