import { z } from 'zod';

export const PUBLICATION_WORKFLOW = 'cloud-agent-runtime-publish.yml';
const NO_RUN_GRACE_MS = 10 * 60_000;

/** Must match `run-name` in the publication workflow; the deploy finds its runs by this title. */
export const publicationRunTitle = (sourceSha: string) =>
  'Publish Cloud Agent runtime ' + sourceSha;

const runsSchema = z.object({
  workflow_runs: z.array(
    z.object({
      display_title: z.string(),
      status: z.string(),
      conclusion: z.string().nullable(),
      html_url: z.string(),
    })
  ),
});
export type PublicationRun = z.infer<typeof runsSchema>['workflow_runs'][number];

export async function readPublicationRuns(
  sourceSha: string,
  repository: string,
  token: string,
  request: typeof fetch = fetch
): Promise<PublicationRun[]> {
  const response = await request(
    `https://api.github.com/repos/${repository}/actions/workflows/${PUBLICATION_WORKFLOW}/runs?per_page=100`,
    {
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(30_000),
    }
  );
  if (!response.ok)
    throw new Error(`Runtime publication runs could not be read (${response.status})`);
  return runsSchema
    .parse(await response.json())
    .workflow_runs.filter(run => run.display_title === publicationRunTitle(sourceSha));
}

/**
 * Explain why waiting for a missing handoff cannot succeed, or return null while it still can.
 * Any queued or running publication (including a re-run) keeps the deploy waiting. Skipped runs
 * belong to unsuccessful CI attempts and never publish.
 */
export function publicationFailure(
  sourceSha: string,
  runs: readonly PublicationRun[],
  waitedMs: number
): string | null {
  const attempts = runs.filter(run => run.conclusion !== 'skipped');
  if (attempts.some(run => run.status !== 'completed')) return null;
  const retry = `Re-run publication with: gh workflow run ${PUBLICATION_WORKFLOW} --ref main -f source_sha=${sourceSha}`;
  if (attempts.length === 0) {
    if (waitedMs < NO_RUN_GRACE_MS) return null;
    return `No runtime publication run for ${sourceSha} started within ${NO_RUN_GRACE_MS / 60_000} minutes. ${retry}`;
  }
  const outcomes = attempts.map(run => `${run.conclusion ?? 'unknown'} ${run.html_url}`).join(', ');
  return `Runtime publication for ${sourceSha} finished without a handoff (${outcomes}). ${retry}`;
}
