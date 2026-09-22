import { describe, expect, it } from 'bun:test';
import { checkoutSyntheticReviewRef, isSyntheticReviewRef } from './git-review-ref';

describe('git review refs', () => {
  it('recognizes provider-owned pull and merge-request refs only', () => {
    expect(isSyntheticReviewRef('refs/pull/123/head')).toBe(true);
    expect(isSyntheticReviewRef('refs/merge-requests/99/head')).toBe(true);
    expect(isSyntheticReviewRef('feature/review')).toBe(false);
    expect(isSyntheticReviewRef('refs/pull/not-a-number/head')).toBe(false);
  });

  it('fetches and checks out the exact review ref with bounded safe diagnostics', async () => {
    const calls: { args: string[]; options?: { cwd?: string; signal?: AbortSignal } }[] = [];
    const progress: string[] = [];
    const controller = new AbortController();
    const secret = 'review-token';
    const errorOutput = `\u001b[31mfatal: couldn't find remote ref refs/pull/404/head ${secret}\u001b[0m`;

    let first: unknown;
    try {
      await checkoutSyntheticReviewRef({
        runGit: async (args, options) => {
          calls.push({ args, options });
          options?.onOutput?.('stderr', 'Receiving objects: 42%');
          return {
            stdout: '',
            stderr: errorOutput,
            exitCode: 128,
          };
        },
        workspacePath: '/workspace',
        branchName: 'refs/pull/404/head',
        signal: controller.signal,
        onProgress: message => progress.push(message),
        redact: value => value.replaceAll(secret, '[redacted]'),
      });
    } catch (error) {
      first = error;
    }
    expect(first).toMatchObject({
      subtype: 'git_branch_missing',
      retryable: false,
      detail: expect.stringContaining("output: fatal: couldn't find remote ref"),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(['fetch', '--progress', 'origin', 'refs/pull/404/head']);
    expect(calls[0]?.options).toMatchObject({
      cwd: '/workspace',
      signal: controller.signal,
    });
    expect(progress).toEqual(['Fetching review branch... Receiving objects: 42%']);
    let missing: unknown;
    try {
      await checkoutSyntheticReviewRef({
        runGit: async () => ({ stdout: '', stderr: errorOutput, exitCode: 128 }),
        workspacePath: '/workspace',
        branchName: 'refs/pull/404/head',
        redact: value => value.replaceAll(secret, '[redacted]'),
      });
    } catch (error) {
      missing = error;
    }
    if (!(missing instanceof Error) || typeof missing !== 'object')
      throw new Error('Missing expected review-ref failure');
    const detail = 'detail' in missing ? String(missing.detail) : '';
    expect(detail).not.toContain(secret);
    expect(detail).toContain('[redacted]');
    expect(detail).not.toContain('\u001b[');
  });

  it('checks out FETCH_HEAD after a successful fetch', async () => {
    const calls: string[][] = [];
    await checkoutSyntheticReviewRef({
      runGit: async args => {
        calls.push(args);
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      workspacePath: '/workspace',
      branchName: 'refs/merge-requests/99/head',
    });

    expect(calls).toEqual([
      ['fetch', '--progress', 'origin', 'refs/merge-requests/99/head'],
      ['checkout', '--progress', '-B', 'refs/merge-requests/99/head', 'FETCH_HEAD'],
    ]);
  });
});
