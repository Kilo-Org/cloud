import fs from 'node:fs/promises';
import { URL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  publicationFailure,
  publicationRunTitle,
  readPublicationRuns,
  type PublicationRun,
} from './runtime-publication-runs.js';

const sha = 'a'.repeat(40);
const run = (status: string, conclusion: string | null, id = 1): PublicationRun => ({
  display_title: publicationRunTitle(sha),
  status,
  conclusion,
  html_url: 'https://github.com/Kilo-Org/cloud/actions/runs/' + id,
});

describe('publication failure detection', () => {
  it('keeps waiting while any publication for the SHA is queued or running', () => {
    expect(
      publicationFailure(sha, [run('completed', 'failure'), run('in_progress', null)], 0)
    ).toBeNull();
    expect(publicationFailure(sha, [run('queued', null)], 60 * 60_000)).toBeNull();
  });

  it('fails as soon as every publication for the SHA finished without a handoff', () => {
    const failure = publicationFailure(sha, [run('completed', 'failure', 7)], 0);
    expect(failure).toContain('finished without a handoff');
    expect(failure).toContain('failure https://github.com/Kilo-Org/cloud/actions/runs/7');
    expect(failure).toContain('-f source_sha=' + sha);
  });

  it('ignores runs skipped for unsuccessful CI attempts', () => {
    expect(publicationFailure(sha, [run('completed', 'skipped')], 0)).toBeNull();
    expect(publicationFailure(sha, [run('completed', 'skipped')], 10 * 60_000)).toContain(
      'No runtime publication run'
    );
  });

  it('waits a bounded grace period for a publication run to appear', () => {
    expect(publicationFailure(sha, [], 9 * 60_000)).toBeNull();
    expect(publicationFailure(sha, [], 10 * 60_000)).toContain('started within 10 minutes');
  });
});

it('reads only the runs titled for the exact SHA', async () => {
  const other = {
    ...run('completed', 'failure', 2),
    display_title: publicationRunTitle('b'.repeat(40)),
  };
  const runs = await readPublicationRuns(sha, 'Kilo-Org/cloud', 'token', (async () =>
    Response.json({
      workflow_runs: [run('in_progress', null, 1), other],
    })) as unknown as typeof fetch);
  expect(runs).toEqual([run('in_progress', null, 1)]);
});

it('matches the publication workflow run name', async () => {
  const workflow = await fs.readFile(
    new URL('../../../.github/workflows/cloud-agent-runtime-publish.yml', import.meta.url),
    'utf8'
  );
  expect(/^run-name: (.*)$/m.exec(workflow)?.[1]).toBe(
    publicationRunTitle('${{ github.event.workflow_run.head_sha || inputs.source_sha }}')
  );
});
