import type { RunView } from '../../src/api';
import type { FakeGithub } from '../support/fake-github';
import type { ContainerStatus, Proxy } from './harness';
import { attested } from './harness';

export const MIGRATIONS = 'packages/db/src/migrations';
export const CODEOWNERS =
  '# Database migrations\n/packages/db/src/migrations/  @eshurakov @iscekic @chrarnoldus @johnnyeric\n';
export const PR_AUTHOR = 99_001;
export const ESHURAKOV = 54751;

export function journalText(tags: readonly string[]): string {
  return JSON.stringify({
    version: '7',
    dialect: 'postgresql',
    entries: tags.map((tag, idx) => ({
      idx,
      version: '7',
      when: 1_769_695_991_111 + idx * 1000,
      tag,
      breakpoints: true,
    })),
  });
}

export function repoFiles(tags: readonly string[], extra: Record<string, string> = {}) {
  return {
    '.github/CODEOWNERS': CODEOWNERS,
    [`${MIGRATIONS}/meta/_journal.json`]: journalText(tags),
    ...Object.fromEntries(tags.map(tag => [`${MIGRATIONS}/${tag}.sql`, `-- ${tag}\nselect 1;`])),
    ...extra,
  };
}

/**
 * main with a base commit (one migration, the review baseline) and a head commit that a
 * squash-merged PR 7 added a migration in, approved by an owner on its final blobs.
 */
export async function seedRepo(github: FakeGithub) {
  const base = await github.push(repoFiles(['0000_base']));
  const headFiles = repoFiles(['0000_base', '0001_widgets'], {
    [`${MIGRATIONS}/meta/0001_snapshot.json`]: '{}',
  });
  const branch = await github.commit(headFiles, base);
  const head = await github.push(headFiles);
  github.pulls.set(head, [
    { number: 7, mergedAt: '2026-11-26T10:00:00Z', baseRef: 'main', authorId: PR_AUTHOR },
  ]);
  github.reviews.set(7, [{ userId: ESHURAKOV, state: 'APPROVED', commitId: branch }]);
  return { base, branch, head };
}

/** Seeds the repository, points the review baseline at its base, and allows `token`. */
export async function readyRun(proxy: Proxy, token = 'tok', runId = '1000', runAttempt = '1') {
  const repo = await seedRepo(proxy.github);
  proxy.env.MIGRATION_REVIEW_BASELINE_SHA = repo.base;
  proxy.sts.allow(token, attested({ sha: repo.head, runId, runAttempt }));
  return repo;
}

export type ApiBody = {
  status: string;
  reason?: string;
  run?: RunView;
  activeRunId?: string;
  retryAfterSeconds?: number;
  attemptedSha?: string;
};

export async function post(proxy: Proxy, sha: string, token = 'tok') {
  const response = await proxy.request('POST', '/v1/runs', {
    token,
    body: JSON.stringify({ sha }),
  });
  return {
    status: response.status,
    headers: response.headers,
    body: (await response.json()) as ApiBody,
  };
}

export function doneStatus(
  runId: string,
  overrides: Partial<ContainerStatus> = {}
): ContainerStatus {
  return {
    runId,
    phase: 'done',
    pair: { pid: 4242, backendStart: '2026-11-27T10:00:00.123456Z' },
    pending: ['0001_widgets'],
    applied: [{ tag: '0001_widgets', hash: 'a'.repeat(64), createdAt: 1_769_695_992_111 }],
    cleanup: { terminated: 1, unexpected: 0 },
    failure: null,
    heartbeatAt: new Date().toISOString(),
    ...overrides,
  };
}
