import { generateKeyPairSync } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createGithubClient, type GithubClient } from '../../src/github';
import { checkCodeowners } from '../../src/owners';
import {
  MIGRATIONS_DIR,
  changedPaths,
  reviewChanges,
  subtreeSha,
  type PathPassed,
  type VerdictCache,
} from '../../src/review';
import { FakeGithub, type FakeReview } from '../support/fake-github';

/** The owner-approval check (contract §5 step 5, R5-M1) against a fake GitHub. */

const OWNER = { eshurakov: 54751, iscekic: 4062236, chrarnoldus: 12196001, johnnyeric: 2350930 };
const AUTHOR = 99_001;
const SQL = `${MIGRATIONS_DIR}/0002_add_widgets.sql`;
const JOURNAL = `${MIGRATIONS_DIR}/meta/_journal.json`;
const SNAPSHOT = `${MIGRATIONS_DIR}/meta/0002_snapshot.json`;
const OLD_SQL = `${MIGRATIONS_DIR}/0001_base.sql`;
const OTHER = 'apps/web/src/page.ts';
const MERGED = '2026-11-20T10:00:00Z';

const pem = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey;

let github: FakeGithub;
let client: GithubClient;
let base: string;
const baseFiles = { [OLD_SQL]: 'create table base();', [JOURNAL]: '{"v":1}', [OTHER]: 'v1' };
const prFiles = {
  ...baseFiles,
  [SQL]: 'create table widgets();',
  [JOURNAL]: '{"v":2}',
  [SNAPSHOT]: '{"s":2}',
};

beforeEach(async () => {
  github = new FakeGithub();
  client = createGithubClient(
    {
      appId: '1',
      installationId: '2',
      apiUrl: 'https://api.github.com',
      privateKey: async () => pem,
    },
    github.fetch
  );
  base = await github.push(baseFiles);
});

function memoryVerdicts(): VerdictCache & { saved: PathPassed[] } {
  const saved: PathPassed[] = [];
  return {
    saved,
    passed: (path, blob) => saved.find(item => item.path === path && item.blob === blob) ?? null,
    savePassed: verdict => saved.push(verdict),
  };
}

async function review(head: string, reviewBase = base, verdicts = memoryVerdicts()) {
  const changes = await changedPaths(
    sha => client.tree(sha),
    MIGRATIONS_DIR,
    await subtreeSha(sha => client.tree(sha), head, MIGRATIONS_DIR),
    await subtreeSha(sha => client.tree(sha), reviewBase, MIGRATIONS_DIR)
  );
  return await reviewChanges(client, verdicts, head, changes);
}

/** A PR branch commit off `parent`, then its squash merge onto main, approved as given. */
async function squashMerge(
  files: Record<string, string>,
  reviews: (branch: string) => FakeReview[],
  pr = 7,
  author = AUTHOR
): Promise<{ branch: string; merge: string }> {
  const branch = await github.commit(files, base);
  const merge = await github.push(files);
  github.pulls.set(merge, [{ number: pr, mergedAt: MERGED, baseRef: 'main', authorId: author }]);
  github.reviews.set(pr, reviews(branch));
  return { branch, merge };
}

const approve = (userId: number, commitId: string, login?: string): FakeReview => ({
  userId,
  state: 'APPROVED',
  commitId,
  ...(login === undefined ? {} : { login }),
});

describe('the owner-approval check', () => {
  it('passes a squash-merged PR an owner approved on the final blobs', async () => {
    const { merge } = await squashMerge(prFiles, branch => [approve(OWNER.eshurakov, branch)]);
    const result = await review(merge);
    expect(result.failed).toEqual([]);
    expect(result.passed.map(item => [item.path, item.pr, item.approver]).sort()).toEqual(
      [
        [JOURNAL, 7, 'eshurakov'],
        [SNAPSHOT, 7, 'eshurakov'],
        [SQL, 7, 'eshurakov'],
      ].sort()
    );
  });

  it('fails SQL changed after the approval: approval_on_other_blob', async () => {
    const approved = await github.commit(prFiles, base);
    const merge = await github.push({ ...prFiles, [SQL]: 'drop table users;' });
    github.pulls.set(merge, [{ number: 7, mergedAt: MERGED, baseRef: 'main', authorId: AUTHOR }]);
    github.reviews.set(7, [approve(OWNER.iscekic, approved)]);
    const result = await review(merge);
    expect(result.failed).toEqual([
      { path: SQL, blob: github.blobOf(merge, SQL), reason: 'approval_on_other_blob', pr: 7 },
    ]);
    expect(result.passed.map(item => item.path).sort()).toEqual([JOURNAL, SNAPSHOT].sort());
  });

  it('passes a PR that merged main after the approval with its migration blobs unchanged', async () => {
    const approved = await github.commit(prFiles, base);
    await github.push({ ...baseFiles, [OTHER]: 'v2' });
    const synced = await github.commit({ ...prFiles, [OTHER]: 'v2' }, approved);
    const merge = await github.push({ ...prFiles, [OTHER]: 'v2' });
    github.pulls.set(merge, [{ number: 7, mergedAt: MERGED, baseRef: 'main', authorId: AUTHOR }]);
    github.reviews.set(7, [
      approve(OWNER.chrarnoldus, approved),
      { userId: AUTHOR, state: 'COMMENTED', commitId: synced },
    ]);
    expect((await review(merge)).failed).toEqual([]);
  });

  it('fails an approval only by the author, an owner: author_only', async () => {
    const { merge } = await squashMerge(
      prFiles,
      branch => [approve(OWNER.iscekic, branch)],
      7,
      OWNER.iscekic
    );
    expect((await review(merge)).failed.map(item => item.reason)).toEqual([
      'author_only',
      'author_only',
      'author_only',
    ]);
  });

  it('fails an approval by a non-owner: no_owner_approval', async () => {
    const { merge } = await squashMerge(prFiles, branch => [approve(55_555, branch)]);
    expect(new Set((await review(merge)).failed.map(item => item.reason))).toEqual(
      new Set(['no_owner_approval'])
    );
  });

  it('fails when that owner later requested changes', async () => {
    const { merge } = await squashMerge(prFiles, branch => [
      approve(OWNER.johnnyeric, branch),
      { userId: OWNER.johnnyeric, state: 'CHANGES_REQUESTED', commitId: branch },
    ]);
    expect(new Set((await review(merge)).failed.map(item => item.reason))).toEqual(
      new Set(['no_owner_approval'])
    );
  });

  it('fails a commit with no merged PR: no_pr', async () => {
    const merge = await github.push(prFiles);
    github.pulls.set(merge, [{ number: 8, mergedAt: null, baseRef: 'main', authorId: AUTHOR }]);
    expect(new Set((await review(merge)).failed.map(item => item.reason))).toEqual(
      new Set(['no_pr'])
    );
  });

  it('finds the PR of a rebase merge from each rebased commit', async () => {
    const branch = await github.commit(prFiles, base);
    const first = await github.push({ ...baseFiles, [SQL]: prFiles[SQL] });
    const second = await github.push(prFiles);
    for (const commit of [first, second]) {
      github.pulls.set(commit, [
        { number: 9, mergedAt: MERGED, baseRef: 'main', authorId: AUTHOR },
      ]);
    }
    github.reviews.set(9, [approve(OWNER.eshurakov, branch)]);
    const result = await review(second);
    expect(result.failed).toEqual([]);
    expect(new Set(result.passed.map(item => item.pr))).toEqual(new Set([9]));
  });

  it('finds the PR of a merge commit through the branch commit path history names', async () => {
    const branch = await github.commit(prFiles, base);
    const merge = await github.push(prFiles);
    for (const path of [SQL, JOURNAL, SNAPSHOT]) github.touching.set(`${merge}:${path}`, branch);
    github.pulls.set(branch, [
      { number: 10, mergedAt: MERGED, baseRef: 'main', authorId: AUTHOR },
      { number: 11, mergedAt: null, baseRef: 'main', authorId: AUTHOR },
      { number: 12, mergedAt: MERGED, baseRef: 'release', authorId: AUTHOR },
    ]);
    github.reviews.set(10, [approve(OWNER.iscekic, branch)]);
    const result = await review(merge);
    expect(result.failed).toEqual([]);
    expect(new Set(result.passed.map(item => item.pr))).toEqual(new Set([10]));
  });

  it('refuses the whole run when one of several files fails', async () => {
    const approved = await github.commit(prFiles, base);
    const merge = await github.push({ ...prFiles, [SNAPSHOT]: '{"s":3}' });
    github.pulls.set(merge, [{ number: 7, mergedAt: MERGED, baseRef: 'main', authorId: AUTHOR }]);
    github.reviews.set(7, [approve(OWNER.eshurakov, approved)]);
    const result = await review(merge);
    expect(result.failed.map(item => item.path)).toEqual([SNAPSHOT]);
    expect(result.passed).toHaveLength(2);
  });

  it("checks a journal two PRs changed against the last PR's approved journal", async () => {
    const firstBranch = await github.commit(prFiles, base);
    const first = await github.push(prFiles);
    github.pulls.set(first, [{ number: 20, mergedAt: MERGED, baseRef: 'main', authorId: AUTHOR }]);
    github.reviews.set(20, [approve(OWNER.eshurakov, firstBranch)]);
    const secondFiles = { ...prFiles, [JOURNAL]: '{"v":3}' };
    const staleApproval = await github.commit({ ...secondFiles, [JOURNAL]: '{"v":2}' }, first);
    const second = await github.push(secondFiles);
    github.pulls.set(second, [{ number: 21, mergedAt: MERGED, baseRef: 'main', authorId: AUTHOR }]);

    github.reviews.set(21, [approve(OWNER.iscekic, staleApproval)]);
    const stale = await review(second);
    expect(stale.failed).toEqual([
      {
        path: JOURNAL,
        blob: github.blobOf(second, JOURNAL),
        reason: 'approval_on_other_blob',
        pr: 21,
      },
    ]);

    const freshApproval = await github.commit(secondFiles, first);
    github.reviews.set(21, [approve(OWNER.iscekic, freshApproval)]);
    const fresh = await review(second);
    expect(fresh.failed).toEqual([]);
    expect(fresh.passed.find(item => item.path === JOURNAL)?.pr).toBe(21);
  });

  it('needs an approval at a commit where a deleted path is absent', async () => {
    const { [OLD_SQL]: _deleted, ...withoutOld } = baseFiles;
    const stillThere = await github.commit(baseFiles, base);
    const merge = await github.push(withoutOld);
    github.pulls.set(merge, [{ number: 30, mergedAt: MERGED, baseRef: 'main', authorId: AUTHOR }]);

    github.reviews.set(30, [approve(OWNER.chrarnoldus, stillThere)]);
    expect((await review(merge)).failed).toEqual([
      { path: OLD_SQL, blob: null, reason: 'approval_on_other_blob', pr: 30 },
    ]);

    const absent = await github.commit(withoutOld, base);
    github.reviews.set(30, [approve(OWNER.chrarnoldus, absent)]);
    const result = await review(merge);
    expect(result.failed).toEqual([]);
    expect(result.passed).toEqual([{ path: OLD_SQL, blob: null, pr: 30, approver: 'chrarnoldus' }]);
  });

  it('ignores an approval by an account with an owner login but another id (R5-M1)', async () => {
    const { merge } = await squashMerge(prFiles, branch => [approve(77_777, branch, 'eshurakov')]);
    expect(new Set((await review(merge)).failed.map(item => item.reason))).toEqual(
      new Set(['no_owner_approval'])
    );
  });

  it('counts an approval by a pinned id whose login changed', async () => {
    const { merge } = await squashMerge(prFiles, branch => [
      approve(OWNER.eshurakov, branch, 'eshurakov-renamed'),
    ]);
    const result = await review(merge);
    expect(result.failed).toEqual([]);
    expect(new Set(result.passed.map(item => item.approver))).toEqual(new Set(['eshurakov']));
  });

  it('compares author ids: an owner approving their own PR under another login is author_only', async () => {
    const { merge } = await squashMerge(
      prFiles,
      branch => [approve(OWNER.johnnyeric, branch, 'johnny-alt')],
      7,
      OWNER.johnnyeric
    );
    expect(new Set((await review(merge)).failed.map(item => item.reason))).toEqual(
      new Set(['author_only'])
    );
  });

  it('fails a commit that maps to two merged PRs into main: ambiguous_pr', async () => {
    const { merge } = await squashMerge(prFiles, branch => [approve(OWNER.eshurakov, branch)]);
    github.pulls.set(merge, [
      { number: 7, mergedAt: MERGED, baseRef: 'main', authorId: AUTHOR },
      { number: 8, mergedAt: MERGED, baseRef: 'main', authorId: AUTHOR },
    ]);
    expect(new Set((await review(merge)).failed.map(item => item.reason))).toEqual(
      new Set(['ambiguous_pr'])
    );
  });

  it('re-checks only paths whose blob changed', async () => {
    const { merge } = await squashMerge(prFiles, branch => [approve(OWNER.eshurakov, branch)]);
    const verdicts = memoryVerdicts();
    await review(merge, base, verdicts);
    github.calls = [];
    const again = await review(merge, base, verdicts);
    expect(again.failed).toEqual([]);
    expect(
      github.calls.filter(call => call.includes('/pulls') || call.includes('/commits'))
    ).toEqual([]);
  });

  it('passes with nothing to check when the migrations tree equals the base', async () => {
    expect(await review(base)).toEqual({ passed: [], failed: [] });
  });
});

describe('checkCodeowners (R5-M1)', () => {
  const line = (owners: string) =>
    `# owners\n/packages/db/src/migrations/  ${owners}\n/services/x/ @a\n`;
  const pinned = '@eshurakov @iscekic @chrarnoldus @johnnyeric';

  it('accepts the pinned logins in any order and case', () => {
    expect(checkCodeowners(line(pinned))).toBe('ok');
    expect(checkCodeowners(line('@JohnnyEric @chrarnoldus @iscekic @eshurakov'))).toBe('ok');
  });

  it.each([
    ['one added', `${pinned} @pandemicsyn`],
    ['one removed', '@eshurakov @iscekic @chrarnoldus'],
    ['a team', '@eshurakov @iscekic @chrarnoldus @Kilo-Org/db'],
    ['a renamed login', '@eshurakov @iscekic @chrarnoldus @johnny-eric'],
    ['an email', '@eshurakov @iscekic @chrarnoldus johnny@example.com'],
    ['no owners', ''],
  ])('refuses a migrations line with %s: owners_mismatch', (_label, owners) => {
    expect(checkCodeowners(line(owners))).toBe('owners_mismatch');
  });

  it('refuses a file without the migrations line, and reads a missing file as unreadable', () => {
    expect(checkCodeowners('/services/x/ @a\n')).toBe('owners_mismatch');
    expect(checkCodeowners(null)).toBe('owners_unreadable');
  });

  it('uses the last migrations line, as GitHub does', () => {
    expect(checkCodeowners(`${line(pinned)}/packages/db/src/migrations/ @someone\n`)).toBe(
      'owners_mismatch'
    );
  });
});
