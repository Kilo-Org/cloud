import { describe, expect, it } from 'bun:test';
import {
  GIT_FAILURE_PROVENANCE_MAX_LENGTH,
  formatGitFailureProvenance,
  gitOperationError,
} from './git-errors.js';
import type { ExecResult } from './utils.js';

function gitResult(stderr: string, exitCode = 128): ExecResult {
  return { stdout: '', stderr, exitCode };
}

const REAL_429 =
  "fatal: unable to access 'https://github.com/acme/private-repo.git/': The requested URL returned error: 429";
const TEXTUAL_RATE_LIMIT = 'fatal: unable to access repository: too many requests';
const UNMATCHED = 'fatal: some brand new git failure nobody classified';

describe('gitOperationError provenance', () => {
  it('distinguishes a real HTTP 429 from a textual rate-limit match', () => {
    const real = gitOperationError(gitResult(REAL_429), 'clone', undefined, 'managed');
    const textual = gitOperationError(gitResult(TEXTUAL_RATE_LIMIT), 'clone', undefined, 'managed');

    // Classification itself is unchanged: both are git_rate_limited.
    expect(real.subtype).toBe('git_rate_limited');
    expect(textual.subtype).toBe('git_rate_limited');

    expect(real.gitFailure).toBe('matcher=git_rate_limited http=429 operation=clone route=managed');
    expect(textual.gitFailure).toBe(
      'matcher=git_rate_limited http=none operation=clone route=managed'
    );
  });

  it('does not read a 429 from clone progress object counts', () => {
    const error = gitOperationError(
      gitResult(
        'remote: Enumerating objects: 429, done.\n' +
          'remote: Total 429 (delta 12), reused 100 (delta 30), pack-reused 0\n' +
          'fatal: the remote end hung up unexpectedly'
      ),
      'clone',
      undefined,
      'managed'
    );

    expect(error.subtype).toBe('git_network_failed');
    expect(error.gitFailure).toBe(
      'matcher=git_network_failed http=none operation=clone route=managed'
    );
  });

  it('reports an unmatched failure with no status', () => {
    const error = gitOperationError(gitResult(UNMATCHED), 'clone', undefined, 'direct');

    expect(error.subtype).toBe('workspace_setup_unknown');
    expect(error.gitFailure).toBe('matcher=unmatched http=none operation=clone route=direct');
  });

  it('reports a git process timeout', () => {
    const error = gitOperationError(
      { stdout: '', stderr: '', exitCode: 124, terminationReason: 'timeout' },
      'clone',
      undefined,
      'direct'
    );

    expect(error.subtype).toBe('git_clone_timeout');
    expect(error.gitFailure).toBe('matcher=timeout http=none operation=clone route=direct');
  });

  it('reports the checkout conflict branch for a checkout operation', () => {
    const error = gitOperationError(
      gitResult('error: Your local changes would be overwritten by checkout', 1),
      'checkout',
      undefined,
      'unknown'
    );

    expect(error.subtype).toBe('git_checkout_conflict');
    expect(error.gitFailure).toBe(
      'matcher=checkout_conflict http=none operation=checkout route=unknown'
    );
  });

  it('defaults an unspecified route to unknown instead of guessing managed or direct', () => {
    const error = gitOperationError(gitResult(TEXTUAL_RATE_LIMIT), 'clone');

    expect(error.gitFailure).toContain('route=unknown');
  });

  it('emits an allowlisted, bounded summary with no raw output, URL, path or token', () => {
    const token = 'ghs_supersecrettokenvalue';
    const url = 'https://github.com/acme/private-repo.git';
    const error = gitOperationError(
      gitResult(
        `fatal: unable to access '${url}/': The requested URL returned error: 429 token ${token}`
      ),
      'clone',
      undefined,
      'managed'
    );

    const summary = error.gitFailure ?? '';
    expect(summary).toBe('matcher=git_rate_limited http=429 operation=clone route=managed');
    expect(summary).not.toContain(url);
    expect(summary).not.toContain('github.com');
    expect(summary).not.toContain('private-repo');
    expect(summary).not.toContain(token);
    expect(summary.length).toBeLessThanOrEqual(GIT_FAILURE_PROVENANCE_MAX_LENGTH);
    // Behavior unchanged: the detailed failure message still carries diagnostics.
    expect(error.detail).toContain('output:');
  });

  it('bounds every allowlisted field combination', () => {
    const summary = formatGitFailureProvenance({
      matcher: 'checkout_conflict',
      operation: 'checkout',
      route: 'unknown',
      httpStatus: 429,
    });

    expect(summary.length).toBeLessThanOrEqual(GIT_FAILURE_PROVENANCE_MAX_LENGTH);
  });
});
