import fs from 'node:fs/promises';
import { URL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  probePublication,
  publicationFailure,
  publicationRunTitle,
  readPublicationRuns,
  type CiRun,
  type PublicationRun,
} from './runtime-publication-runs.js';

const sha = 'a'.repeat(40);
const run = (status: string, conclusion: string | null, id = 1): PublicationRun => ({
  display_title: publicationRunTitle(sha),
  head_branch: 'main',
  status,
  conclusion,
  html_url: 'https://github.com/Kilo-Org/cloud/actions/runs/' + id,
});
const now = Date.parse('2026-11-04T12:00:00Z');
const ci = (status: string, conclusion: string | null, minutesAgo = 0): CiRun => ({
  status,
  conclusion,
  updated_at: new Date(now - minutesAgo * 60_000).toISOString(),
});

describe('publication failure detection', () => {
  it('keeps waiting while any publication for the SHA is queued or running', () => {
    expect(
      publicationFailure(sha, [run('completed', 'failure'), run('in_progress', null)], [], 0, now)
    ).toBeNull();
    expect(publicationFailure(sha, [run('queued', null)], [], 60 * 60_000, now)).toBeNull();
  });

  it('fails as soon as every publication for the SHA finished without a handoff', () => {
    const failure = publicationFailure(sha, [run('completed', 'failure', 7)], [], 0, now);
    expect(failure).toContain('finished without a handoff');
    expect(failure).toContain('failure https://github.com/Kilo-Org/cloud/actions/runs/7');
    expect(failure).toContain('-f source_sha=' + sha);
  });

  it('ignores runs skipped for unsuccessful CI attempts', () => {
    const skipped = [run('completed', 'skipped')];
    expect(publicationFailure(sha, skipped, [ci('completed', 'success', 1)], 0, now)).toBeNull();
    expect(
      publicationFailure(sha, skipped, [ci('completed', 'success', 10)], 10 * 60_000, now)
    ).toContain('No runtime publication run');
  });

  it('keeps waiting while CI for the SHA has not finished, however long the deploy waited', () => {
    expect(publicationFailure(sha, [], [ci('in_progress', null)], 30 * 60_000, now)).toBeNull();
    expect(publicationFailure(sha, [], [ci('queued', null)], 30 * 60_000, now)).toBeNull();
  });

  it('counts the no-run grace period from the CI success', () => {
    expect(
      publicationFailure(sha, [], [ci('completed', 'success', 9)], 30 * 60_000, now)
    ).toBeNull();
    const failure = publicationFailure(sha, [], [ci('completed', 'success', 10)], 0, now);
    expect(failure).toContain('started within 10 minutes of its CI succeeding');
    expect(failure).toContain('-f source_sha=' + sha);
  });

  it('fails without a re-run command when the SHA has no successful main CI run', () => {
    expect(
      publicationFailure(sha, [], [ci('completed', 'failure', 30)], 9 * 60_000, now)
    ).toBeNull();
    const failure = publicationFailure(sha, [], [ci('completed', 'failure', 30)], 10 * 60_000, now);
    expect(failure).toContain('No successful main CI run');
    expect(failure).not.toContain('gh workflow run');
    expect(publicationFailure(sha, [], [], 10 * 60_000, now)).toContain(
      'No successful main CI run'
    );
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

it('ignores runs titled for the SHA on other branches', async () => {
  const dispatch = { ...run('completed', 'failure', 2), head_branch: 'feature' };
  const runs = await readPublicationRuns(sha, 'Kilo-Org/cloud', 'token', (async () =>
    Response.json({ workflow_runs: [dispatch] })) as unknown as typeof fetch);
  expect(runs).toEqual([]);
});

it('reads later pages until the run list ends', async () => {
  const other = {
    ...run('completed', 'success', 2),
    display_title: publicationRunTitle('b'.repeat(40)),
  };
  const request = vi.fn(async (input: string) =>
    Response.json({
      workflow_runs: input.endsWith('page=1') ? Array(100).fill(other) : [run('queued', null, 9)],
    })
  );
  const runs = await readPublicationRuns(
    sha,
    'Kilo-Org/cloud',
    'token',
    request as unknown as typeof fetch
  );
  expect(runs).toEqual([run('queued', null, 9)]);
  expect(request).toHaveBeenCalledTimes(2);
  expect(request).toHaveBeenLastCalledWith(
    'https://api.github.com/repos/Kilo-Org/cloud/actions/workflows/cloud-agent-runtime-publish.yml/runs?branch=main&per_page=100&page=2',
    expect.anything()
  );
});

describe('publication probe', () => {
  const github = (routes: { publication: unknown[]; ci: CiRun[] }) =>
    vi.fn(async (input: string) =>
      Response.json({
        workflow_runs: input.includes('/ci.yml/') ? routes.ci : routes.publication,
      })
    );

  it('reads main push CI for the SHA while no publication has started', async () => {
    const request = github({ publication: [], ci: [ci('in_progress', null)] });
    await expect(
      probePublication(
        sha,
        'Kilo-Org/cloud',
        'token',
        30 * 60_000,
        request as unknown as typeof fetch
      )
    ).resolves.toBeNull();
    expect(request).toHaveBeenLastCalledWith(
      `https://api.github.com/repos/Kilo-Org/cloud/actions/workflows/ci.yml/runs?head_sha=${sha}&event=push&branch=main&per_page=10`,
      expect.anything()
    );
  });

  it('does not read CI once a publication attempt exists', async () => {
    const request = github({ publication: [run('completed', 'failure', 3)], ci: [] });
    await expect(
      probePublication(sha, 'Kilo-Org/cloud', 'token', 0, request as unknown as typeof fetch)
    ).resolves.toContain('finished without a handoff');
    expect(request).toHaveBeenCalledTimes(1);
  });
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
