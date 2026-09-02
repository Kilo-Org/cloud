import { describe, expect, it, vi } from 'vitest';
import {
  admitRepository,
  cloneRepository,
  MAX_REPO_BLOB_BYTES,
  MAX_REPO_PATH_BYTES,
  MAX_REPO_SIZE_KIB,
  MAX_REPO_TOTAL_BLOB_BYTES,
  MAX_REPO_TOTAL_PATH_BYTES,
  MAX_REPO_TREE_ENTRIES,
  RepoTooLargeError,
  resolveHeadSha,
  resolveReviewSnapshot,
  type ReviewWorkspace,
} from '../../src/git';
import { createGithubClient, MAX_GITHUB_RESPONSE_BYTES, type GithubClient } from '../../src/github';

function githubWithGet(get: GithubClient['get']): GithubClient {
  return {
    get,
    getResponse: vi.fn(),
    getTextResponse: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    paginate: vi.fn(),
  };
}

const snapshot = {
  headSha: 'a'.repeat(40),
  baseTipSha: 'b'.repeat(40),
  mergeBaseSha: 'c'.repeat(40),
};
const snapshotInput = {
  owner: 'acme',
  repo: 'widget',
  pullNumber: 42,
  kiloToken: 'fixture-kilo',
  gitToken: 'fixture-git',
};

function snapshotClient() {
  const pull = { head: { sha: snapshot.headSha }, base: { sha: snapshot.baseTipSha } };
  const comparison = {
    base_commit: { sha: snapshot.baseTipSha },
    merge_base_commit: { sha: snapshot.mergeBaseSha },
  };
  const get = vi
    .fn()
    .mockResolvedValueOnce(pull)
    .mockResolvedValueOnce(comparison)
    .mockResolvedValueOnce(pull);
  return { get, github: githubWithGet(get), pull, comparison };
}

const rootTreeSha = 'd'.repeat(40);

function treeBlob(path: string, size = 1) {
  return { path, size, sha: 'e'.repeat(40), type: 'blob', mode: '100644' };
}

function admissionClient(entries: unknown[] = [treeBlob('README.md')], sizeKiB = 1) {
  const metadata = { size: sizeKiB };
  const commit = { sha: snapshot.headSha, tree: { sha: rootTreeSha } };
  const tree = { sha: rootTreeSha, truncated: false, tree: entries };
  const get = vi
    .fn()
    .mockResolvedValueOnce(metadata)
    .mockResolvedValueOnce(commit)
    .mockResolvedValueOnce(tree);
  return { github: githubWithGet(get), get, metadata, commit, tree };
}

function cloneWorkspace() {
  return {
    rm: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    git: {
      clone: vi.fn().mockResolvedValue(undefined),
      revParse: vi.fn().mockResolvedValue(snapshot.headSha),
    },
    glob: vi.fn().mockResolvedValue([]),
    stat: vi.fn(),
  };
}

describe('immutable review snapshot', () => {
  it('captures distinct base tip and merge base with an exact comparison and a closing freshness fence', async () => {
    const { github, get } = snapshotClient();
    const { signal } = new AbortController();
    await expect(
      resolveReviewSnapshot(github, { ...snapshotInput, ...snapshot }, signal)
    ).resolves.toEqual(snapshot);
    expect(get.mock.calls.map(call => call[0])).toEqual([
      '/repos/acme/widget/pulls/42',
      `/repos/acme/widget/compare/${snapshot.baseTipSha}...${snapshot.headSha}?per_page=1`,
      '/repos/acme/widget/pulls/42',
    ]);
    expect(get.mock.calls.every(call => call[2] === signal)).toBe(true);
  });

  it.each(['head', 'base'] as const)(
    'rejects a changed %s while capturing the comparison, including dry-run',
    async field => {
      const { github, get, pull } = snapshotClient();
      get
        .mockReset()
        .mockResolvedValueOnce(pull)
        .mockResolvedValueOnce({
          base_commit: { sha: snapshot.baseTipSha },
          merge_base_commit: { sha: snapshot.mergeBaseSha },
        })
        .mockResolvedValueOnce({ ...pull, [field]: { sha: 'd'.repeat(40) } });
      await expect(
        resolveReviewSnapshot(github, { ...snapshotInput, dryRun: true })
      ).rejects.toThrow('changed while capturing');
    }
  );

  it.each([
    { head: { sha: snapshot.headSha } },
    { base: { sha: snapshot.baseTipSha } },
    { head: { sha: 'not-a-sha' }, base: { sha: snapshot.baseTipSha } },
    null,
  ])('rejects missing or malformed snapshot metadata', async pull => {
    const github = githubWithGet(vi.fn().mockResolvedValue(pull));
    await expect(resolveReviewSnapshot(github, snapshotInput)).rejects.toThrow(
      'missing valid head/base SHAs'
    );
  });

  it.each([
    {},
    { base_commit: { sha: snapshot.baseTipSha } },
    { base_commit: { sha: 'd'.repeat(40) }, merge_base_commit: { sha: snapshot.mergeBaseSha } },
  ])('rejects an unproven comparison base or merge base', async comparison => {
    const { github, get, pull } = snapshotClient();
    get.mockReset().mockResolvedValueOnce(pull).mockResolvedValueOnce(comparison);
    await expect(resolveReviewSnapshot(github, snapshotInput)).rejects.toThrow(
      'comparison is missing or mismatches'
    );
  });

  it.each(['headSha', 'baseTipSha', 'mergeBaseSha'] as const)(
    'rejects a mismatched prepared %s',
    async field => {
      const { github } = snapshotClient();
      await expect(
        resolveReviewSnapshot(github, { ...snapshotInput, ...snapshot, [field]: 'd'.repeat(40) })
      ).rejects.toThrow('does not match');
    }
  );

  it('stops after a delayed head read ignores cancellation', async () => {
    const controller = new AbortController();
    const get = vi.fn(async () => {
      controller.abort();
      return { head: { sha: snapshot.headSha }, base: { sha: snapshot.baseTipSha } };
    });
    await expect(
      resolveReviewSnapshot(githubWithGet(get), snapshotInput, controller.signal)
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(get).toHaveBeenCalledOnce();
  });
});

describe('captured-tree repository admission', () => {
  it('reads the captured commit and its complete recursive tree with the admission signal', async () => {
    const { github, get } = admissionClient([
      treeBlob('src/main.ts'),
      { path: 'src', sha: 'f'.repeat(40), type: 'tree', mode: '040000' },
      { ...treeBlob('bin/run'), mode: '100755' },
      { path: 'bin', sha: '1'.repeat(40), type: 'tree', mode: '040000' },
      { ...treeBlob('source-link', 3), mode: '120000' },
      { path: 'submodule', sha: '2'.repeat(40), type: 'commit', mode: '160000' },
    ]);
    const { signal } = new AbortController();
    await expect(
      admitRepository(github, 'acme', 'widget', snapshot.headSha.toUpperCase(), signal)
    ).resolves.toEqual({ sizeKiB: 1 });
    expect(get.mock.calls).toEqual([
      ['/repos/acme/widget', undefined, signal],
      [`/repos/acme/widget/git/commits/${snapshot.headSha}`, undefined, signal],
      [`/repos/acme/widget/git/trees/${rootTreeSha}?recursive=1`, undefined, signal],
    ]);
  });

  it('rejects malformed head SHAs before requesting admission metadata', async () => {
    const { github, get } = admissionClient();
    await expect(admitRepository(github, 'acme', 'widget', 'main')).rejects.toThrow(
      'headSha must be a full git commit SHA'
    );
    expect(get).not.toHaveBeenCalled();
  });

  it.each([
    null,
    {},
    { size: '1' },
    { size: -1 },
    { size: 0.5 },
    { size: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects malformed repository admission metadata', async metadata => {
    const get = vi.fn().mockResolvedValue(metadata);
    await expect(
      admitRepository(githubWithGet(get), 'acme', 'widget', snapshot.headSha)
    ).rejects.toThrow('valid size');
    expect(get).toHaveBeenCalledOnce();
  });

  it('keeps the repository metadata gate ahead of all tree requests', async () => {
    const { github, get } = admissionClient([], MAX_REPO_SIZE_KIB + 1);
    await expect(
      admitRepository(github, 'acme', 'widget', snapshot.headSha)
    ).rejects.toBeInstanceOf(RepoTooLargeError);
    expect(get).toHaveBeenCalledOnce();
  });

  it('admits blobs exactly at both uncompressed budgets and the metadata cap', async () => {
    const entries = Array.from(
      { length: MAX_REPO_TOTAL_BLOB_BYTES / MAX_REPO_BLOB_BYTES },
      (_, i) => treeBlob(`file-${i}.bin`, MAX_REPO_BLOB_BYTES)
    );
    const { github } = admissionClient(entries, MAX_REPO_SIZE_KIB);
    await expect(admitRepository(github, 'acme', 'widget', snapshot.headSha)).resolves.toEqual({
      sizeKiB: MAX_REPO_SIZE_KIB,
    });
  });

  it('rejects an unchanged 80 MiB blob even when repository metadata reports only 80 KiB', async () => {
    const { github } = admissionClient(
      [treeBlob('changed.ts', 10), treeBlob('unchanged-compressible.bin', 80 * 1024 * 1024)],
      80
    );
    const workspace = cloneWorkspace();
    await expect(
      admitRepository(github, 'acme', 'widget', snapshot.headSha).then(() =>
        cloneRepository(workspace as unknown as ReviewWorkspace, snapshotInput, snapshot.headSha)
      )
    ).rejects.toMatchObject({
      name: 'RepoTooLargeError',
      sizeKiB: 80,
      message: expect.stringContaining('blob exceeds'),
    });
    expect(workspace.git.clone).not.toHaveBeenCalled();
  });

  it.each(['100644', '100755', '120000'])(
    'rejects a blob one byte over the per-object budget with mode %s',
    async mode => {
      const { github } = admissionClient([{ ...treeBlob('large', MAX_REPO_BLOB_BYTES + 1), mode }]);
      await expect(admitRepository(github, 'acme', 'widget', snapshot.headSha)).rejects.toThrow(
        'blob exceeds'
      );
    }
  );

  it('counts every checkout path, including repeated blob OIDs and symlink bytes, toward the total', async () => {
    const entries = Array.from(
      { length: MAX_REPO_TOTAL_BLOB_BYTES / MAX_REPO_BLOB_BYTES },
      (_, i) => treeBlob(`copy-${i}.bin`, MAX_REPO_BLOB_BYTES)
    );
    const { github } = admissionClient([
      ...entries,
      { ...treeBlob('link', 1), sha: 'f'.repeat(40), mode: '120000' },
    ]);
    await expect(admitRepository(github, 'acme', 'widget', snapshot.headSha)).rejects.toThrow(
      'total uncompressed clone budget'
    );
  });

  it.each([undefined, null, '1', -1, 0.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects a blob whose uncompressed size is missing or unsafe: %s',
    async size => {
      const { github } = admissionClient([{ ...treeBlob('file'), size }]);
      await expect(admitRepository(github, 'acme', 'widget', snapshot.headSha)).rejects.toThrow(
        /invalid entry|missing its uncompressed size/
      );
    }
  );

  it.each([
    null,
    {},
    { sha: snapshot.headSha },
    { sha: snapshot.headSha, tree: { sha: 'main' } },
    { sha: 'f'.repeat(40), tree: { sha: rootTreeSha } },
  ])('rejects an absent or mismatched captured commit before reading its tree', async commit => {
    const { github, get, metadata } = admissionClient();
    get.mockReset().mockResolvedValueOnce(metadata).mockResolvedValueOnce(commit);
    await expect(admitRepository(github, 'acme', 'widget', snapshot.headSha)).rejects.toThrow(
      'mismatches the captured head SHA'
    );
    expect(get).toHaveBeenCalledTimes(2);
  });

  it.each([
    null,
    {},
    { sha: rootTreeSha, tree: [] },
    { sha: rootTreeSha, truncated: true, tree: [] },
    { sha: rootTreeSha, truncated: 'false', tree: [] },
    { sha: rootTreeSha, truncated: false },
    { sha: rootTreeSha, truncated: false, tree: {} },
    { sha: 'f'.repeat(40), truncated: false, tree: [] },
  ])('rejects an incomplete, truncated, or mismatched recursive tree', async tree => {
    const { github, get, metadata, commit } = admissionClient();
    get
      .mockReset()
      .mockResolvedValueOnce(metadata)
      .mockResolvedValueOnce(commit)
      .mockResolvedValueOnce(tree);
    await expect(admitRepository(github, 'acme', 'widget', snapshot.headSha)).rejects.toThrow(
      'incomplete, truncated, or mismatches'
    );
    expect(get).toHaveBeenCalledTimes(3);
  });

  it.each([
    { ...treeBlob('file'), mode: '040000' },
    { ...treeBlob('file'), type: 'commit' },
    { ...treeBlob('file'), mode: '100664' },
    { ...treeBlob('file'), type: 'tag' },
    { ...treeBlob('file'), sha: 'not-a-sha' },
    null,
  ])('rejects unsupported or malformed tree entries', async entry => {
    const { github } = admissionClient([entry]);
    await expect(admitRepository(github, 'acme', 'widget', snapshot.headSha)).rejects.toThrow(
      'invalid entry'
    );
  });

  it('rejects duplicate paths instead of hiding their metadata', async () => {
    const { github } = admissionClient([treeBlob('file'), treeBlob('file')]);
    await expect(admitRepository(github, 'acme', 'widget', snapshot.headSha)).rejects.toThrow(
      'duplicate paths'
    );
  });

  it.each([
    { entries: [treeBlob('missing-parent/file')] },
    { entries: [treeBlob('parent'), treeBlob('parent/file')] },
    { entries: [{ ...treeBlob('parent'), mode: '120000' }, treeBlob('parent/file')] },
    {
      entries: [
        { path: 'parent', sha: 'f'.repeat(40), type: 'commit', mode: '160000' },
        treeBlob('parent/file'),
      ],
    },
  ])('rejects incomplete or non-directory tree ancestry', async ({ entries }) => {
    const { github } = admissionClient(entries);
    await expect(admitRepository(github, 'acme', 'widget', snapshot.headSha)).rejects.toThrow(
      'incomplete or contains a non-directory parent'
    );
  });

  it.each([
    '/absolute',
    '../outside',
    'dir/../outside',
    './file',
    'dir//file',
    'dir/',
    '.git/config',
    'dir/.GIT/config',
    'dir\\file',
    'file\0name',
  ])('rejects the unsafe or unsupported path %j', async path => {
    const { github } = admissionClient([treeBlob(path)]);
    await expect(admitRepository(github, 'acme', 'widget', snapshot.headSha)).rejects.toThrow(
      'unsupported path'
    );
  });

  it('admits empty trees and zero-byte files', async () => {
    for (const entries of [[], [treeBlob('empty', 0)]]) {
      const { github } = admissionClient(entries, 0);
      await expect(admitRepository(github, 'acme', 'widget', snapshot.headSha)).resolves.toEqual({
        sizeKiB: 0,
      });
    }
  });

  it('bounds entry count before parsing entries, including zero-byte files', async () => {
    const entries = Array.from({ length: MAX_REPO_TREE_ENTRIES }, (_, i) =>
      treeBlob(`file-${i}`, 0)
    );
    const atCap = admissionClient(entries);
    await expect(
      admitRepository(atCap.github, 'acme', 'widget', snapshot.headSha)
    ).resolves.toEqual({
      sizeKiB: 1,
    });
    const overCap = admissionClient([...entries, null]);
    await expect(
      admitRepository(overCap.github, 'acme', 'widget', snapshot.headSha)
    ).rejects.toThrow('-entry clone budget');
  });

  it('measures each path in UTF-8 bytes, with an inclusive boundary', async () => {
    const path = 'é'.repeat(MAX_REPO_PATH_BYTES / 2);
    const atCap = admissionClient([treeBlob(path)]);
    await expect(
      admitRepository(atCap.github, 'acme', 'widget', snapshot.headSha)
    ).resolves.toEqual({
      sizeKiB: 1,
    });
    const overCap = admissionClient([treeBlob(`${path}x`)]);
    await expect(
      admitRepository(overCap.github, 'acme', 'widget', snapshot.headSha)
    ).rejects.toThrow('path clone budget');
  });

  it('bounds aggregate path metadata independently of blob bytes and entry count', async () => {
    const entries = Array.from(
      { length: MAX_REPO_TOTAL_PATH_BYTES / MAX_REPO_PATH_BYTES },
      (_, i) => treeBlob(i.toString(16).padStart(MAX_REPO_PATH_BYTES, '0'), 0)
    );
    const atCap = admissionClient(entries);
    await expect(
      admitRepository(atCap.github, 'acme', 'widget', snapshot.headSha)
    ).resolves.toEqual({
      sizeKiB: 1,
    });
    const overCap = admissionClient([...entries, treeBlob('x', 0)]);
    await expect(
      admitRepository(overCap.github, 'acme', 'widget', snapshot.headSha)
    ).rejects.toThrow('total path clone budget');
  });

  it('uses the existing bounded GitHub transport for the recursive tree', async () => {
    const { metadata, commit, tree } = admissionClient();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json(metadata))
      .mockResolvedValueOnce(Response.json(commit))
      .mockResolvedValueOnce(
        Response.json({ ...tree, padding: 'x'.repeat(MAX_GITHUB_RESPONSE_BYTES) })
      );
    const github = createGithubClient('fixture-git', fetch);
    await expect(admitRepository(github, 'acme', 'widget', snapshot.headSha)).rejects.toThrow(
      'transport byte budget'
    );
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('stops before all GitHub reads if admission was already aborted', async () => {
    const { github, get } = admissionClient();
    const controller = new AbortController();
    controller.abort();
    await expect(
      admitRepository(github, 'acme', 'widget', snapshot.headSha, controller.signal)
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(get).not.toHaveBeenCalled();
  });

  it.each([0, 1, 2])('fences an ignored abort after admission read %s', async abortedRead => {
    const { github, get, metadata, commit, tree } = admissionClient();
    const controller = new AbortController();
    get.mockReset();
    for (const [i, response] of [metadata, commit, tree].entries()) {
      get.mockImplementationOnce(async () => {
        if (i === abortedRead) controller.abort();
        return response;
      });
    }
    await expect(
      admitRepository(github, 'acme', 'widget', snapshot.headSha, controller.signal)
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(get).toHaveBeenCalledTimes(abortedRead + 1);
    expect(get.mock.calls.every(call => call[2] === controller.signal)).toBe(true);
  });
});

describe('verified shallow fork acquisition', () => {
  it('verifies HEAD and retries the base repository synthetic PR ref when SHA acquisition fails', async () => {
    const workspace = cloneWorkspace();
    workspace.git.clone.mockRejectedValueOnce(new Error('unadvertised object'));
    await cloneRepository(workspace as unknown as ReviewWorkspace, snapshotInput, snapshot.headSha);
    expect(workspace.git.clone.mock.calls.map(call => call[0])).toEqual([
      expect.objectContaining({
        ref: snapshot.headSha,
        depth: 1,
        singleBranch: true,
        noTags: true,
      }),
      expect.objectContaining({
        ref: 'refs/pull/42/head',
        depth: 1,
        singleBranch: true,
        noTags: true,
      }),
    ]);
    expect(workspace.git.revParse).toHaveBeenCalledWith({ dir: '/workspace', ref: 'HEAD' });
  });

  it('never accepts a different fork branch tip', async () => {
    const workspace = cloneWorkspace();
    workspace.git.revParse.mockResolvedValue('d'.repeat(40));
    await expect(
      cloneRepository(workspace as unknown as ReviewWorkspace, snapshotInput, snapshot.headSha)
    ).rejects.toThrow('Unable to acquire and verify');
    expect(workspace.git.clone).toHaveBeenCalledTimes(2);
    expect(workspace.glob).not.toHaveBeenCalled();
  });

  it('can recover a wrong initial checkout only by verifying the exact synthetic-ref SHA', async () => {
    const workspace = cloneWorkspace();
    workspace.git.revParse.mockResolvedValueOnce('d'.repeat(40));
    await cloneRepository(workspace as unknown as ReviewWorkspace, snapshotInput, snapshot.headSha);
    expect(workspace.git.revParse).toHaveBeenCalledTimes(2);
    expect(workspace.glob).toHaveBeenCalledOnce();
  });

  it('does not retry or inspect a checkout after the non-abortable clone finishes late', async () => {
    const workspace = cloneWorkspace();
    const controller = new AbortController();
    workspace.git.clone.mockImplementationOnce(async () => {
      controller.abort();
    });
    await expect(
      cloneRepository(workspace as unknown as ReviewWorkspace, snapshotInput, snapshot.headSha, {
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(workspace.git.clone).toHaveBeenCalledOnce();
    expect(workspace.git.revParse).not.toHaveBeenCalled();
    expect(workspace.glob).not.toHaveBeenCalled();
  });
});

describe('repository admission and clone inputs', () => {
  it('resolves the pull request head when the caller omits it', async () => {
    const get = vi.fn().mockResolvedValue({
      head: { sha: '0123456789abcdef0123456789abcdef01234567' },
    });
    const github = githubWithGet(get);

    await expect(
      resolveHeadSha(github, {
        owner: 'acme',
        repo: 'widget',
        pullNumber: 42,
        gitToken: 'git-token',
        kiloToken: 'kilo-token',
      })
    ).resolves.toBe('0123456789abcdef0123456789abcdef01234567');
    expect(get).toHaveBeenCalledWith('/repos/acme/widget/pulls/42', undefined, undefined);
  });

  it('validates a supplied head SHA against the freshly fetched pull request', async () => {
    const headSha = '0123456789abcdef0123456789abcdef01234567';
    const get = vi.fn().mockResolvedValue({ head: { sha: headSha } });
    const github = githubWithGet(get);

    await expect(
      resolveHeadSha(github, {
        owner: 'acme',
        repo: 'widget',
        pullNumber: 42,
        gitToken: 'git-token',
        kiloToken: 'kilo-token',
        headSha: headSha.toUpperCase(),
      })
    ).resolves.toBe(headSha);
    expect(get).toHaveBeenCalledWith('/repos/acme/widget/pulls/42', undefined, undefined);
  });

  it('rejects a supplied head SHA when the pull request has advanced', async () => {
    const get = vi.fn().mockResolvedValue({
      head: { sha: 'fedcba9876543210fedcba9876543210fedcba98' },
    });
    const github = githubWithGet(get);

    await expect(
      resolveHeadSha(github, {
        owner: 'acme',
        repo: 'widget',
        pullNumber: 42,
        gitToken: 'git-token',
        kiloToken: 'kilo-token',
        headSha: '0123456789abcdef0123456789abcdef01234567',
      })
    ).rejects.toThrow('Supplied headSha does not match the current pull request head');
    expect(get).toHaveBeenCalledWith('/repos/acme/widget/pulls/42', undefined, undefined);
  });

  it('rejects an invalid pull number before fetching a supplied head SHA', async () => {
    const get = vi.fn();
    const github = githubWithGet(get);

    await expect(
      resolveHeadSha(github, {
        owner: 'acme',
        repo: 'widget',
        pullNumber: 0,
        gitToken: 'git-token',
        kiloToken: 'kilo-token',
        headSha: '0123456789abcdef0123456789abcdef01234567',
      })
    ).rejects.toThrow('pullNumber must be a positive integer');
    expect(get).not.toHaveBeenCalled();
  });

  it('rejects a short or non-hex head SHA', async () => {
    const get = vi.fn();
    const github = githubWithGet(get);

    await expect(
      resolveHeadSha(github, {
        owner: 'acme',
        repo: 'widget',
        pullNumber: 42,
        gitToken: 'git-token',
        kiloToken: 'kilo-token',
        headSha: 'main',
      })
    ).rejects.toThrow('headSha must be a full git commit SHA');
    expect(get).not.toHaveBeenCalled();
  });

  it('clones into /workspace and stats file sizes after glob', async () => {
    const sizes = new Map([
      ['/workspace/src/a.ts', 12],
      ['/workspace/.git/HEAD', 41],
    ]);
    const workspace = {
      rm: vi.fn().mockResolvedValue(undefined),
      mkdir: vi.fn().mockResolvedValue(undefined),
      git: {
        clone: vi.fn().mockResolvedValue(undefined),
        revParse: vi.fn().mockResolvedValue('0123456789abcdef0123456789abcdef01234567'),
      },
      glob: vi.fn().mockResolvedValue([
        { path: '/workspace/src/a.ts', type: 'file', size: 0 },
        { path: '/workspace/.git/HEAD', type: 'file', size: 0 },
        { path: '/workspace/src', type: 'directory', size: 0 },
      ]),
      stat: vi.fn(async (path: string) => ({ path, type: 'file', size: sizes.get(path) ?? 0 })),
    };

    const stats = await cloneRepository(
      workspace as unknown as ReviewWorkspace,
      {
        owner: 'acme',
        repo: 'widget',
        pullNumber: 42,
        gitToken: 'git-token',
        kiloToken: 'kilo-token',
      },
      '0123456789abcdef0123456789abcdef01234567',
      { token: 'minted-token' }
    );

    expect(workspace.rm).toHaveBeenCalledWith('/workspace', { recursive: true, force: true });
    expect(workspace.mkdir).toHaveBeenCalledWith('/workspace', { recursive: true });
    expect(workspace.git.clone).toHaveBeenCalledWith(
      expect.objectContaining({
        dir: '/workspace',
        ref: '0123456789abcdef0123456789abcdef01234567',
        url: 'https://github.com/acme/widget.git',
        headers: { Authorization: `Basic ${btoa('x-access-token:minted-token')}` },
      })
    );
    expect(workspace.glob).toHaveBeenCalledWith('**/*');
    expect(workspace.stat).toHaveBeenCalledTimes(2);
    expect(stats).toMatchObject({
      tipFileCount: 1,
      tipTotalBytes: 12,
      vfsFileCount: 2,
      vfsTotalBytes: 53,
    });
  });

  it('clones from a custom URL template', async () => {
    const workspace = {
      rm: vi.fn().mockResolvedValue(undefined),
      mkdir: vi.fn().mockResolvedValue(undefined),
      git: {
        clone: vi.fn().mockResolvedValue(undefined),
        revParse: vi.fn().mockResolvedValue('0123456789abcdef0123456789abcdef01234567'),
      },
      glob: vi.fn().mockResolvedValue([]),
      stat: vi.fn(),
    };

    await cloneRepository(
      workspace as unknown as ReviewWorkspace,
      {
        owner: 'acme',
        repo: 'widget',
        pullNumber: 42,
        gitToken: 'git-token',
        kiloToken: 'kilo-token',
      },
      '0123456789abcdef0123456789abcdef01234567',
      { cloneUrlTemplate: 'http://127.0.0.1:8877/{owner}/{repo}.git' }
    );

    expect(workspace.git.clone).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'http://127.0.0.1:8877/acme/widget.git',
        headers: { Authorization: `Basic ${btoa('x-access-token:git-token')}` },
      })
    );
  });
});
