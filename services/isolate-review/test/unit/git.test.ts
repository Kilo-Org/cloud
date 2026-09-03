import { describe, expect, it, vi } from 'vitest';
import {
  admitRepository,
  cloneRepository,
  MAX_REPO_SIZE_KIB,
  RepoTooLargeError,
  resolveHeadSha,
  resolveReviewSnapshot,
  type ReviewWorkspace,
} from '../../src/git';
import type { GithubClient } from '../../src/github';

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

  it.each([null, {}, { size: '1' }, { size: -1 }, { size: 0.5 }])(
    'rejects malformed repository admission metadata',
    async metadata => {
      await expect(
        admitRepository(githubWithGet(vi.fn().mockResolvedValue(metadata)), 'acme', 'widget')
      ).rejects.toThrow('valid size');
    }
  );

  it('fences admission completion after an ignored abort', async () => {
    const controller = new AbortController();
    const get = vi.fn(async () => {
      controller.abort();
      return { size: 1 };
    });
    await expect(
      admitRepository(githubWithGet(get), 'acme', 'widget', controller.signal)
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(get).toHaveBeenCalledWith('/repos/acme/widget', undefined, controller.signal);
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
  it('enforces a conservative 32 MiB repository metadata cap', async () => {
    expect(MAX_REPO_SIZE_KIB).toBe(32 * 1024);

    const tooLarge = githubWithGet(vi.fn().mockResolvedValue({ size: MAX_REPO_SIZE_KIB + 1 }));
    await expect(admitRepository(tooLarge, 'acme', 'widget')).rejects.toBeInstanceOf(
      RepoTooLargeError
    );

    const atCap = githubWithGet(vi.fn().mockResolvedValue({ size: MAX_REPO_SIZE_KIB }));
    await expect(admitRepository(atCap, 'acme', 'widget')).resolves.toEqual({
      sizeKiB: MAX_REPO_SIZE_KIB,
    });
  });

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
