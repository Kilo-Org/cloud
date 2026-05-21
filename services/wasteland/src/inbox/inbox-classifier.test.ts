/**
 * Unit tests for `parseCommitSubject`.
 *
 * The classifier's verb-detection has two fallbacks: a literal
 * `wl <verb>: <id>` form (what the canonical CLI emits) and a
 * `-- wl <verb>: <id>` SQL-trailer form (what our cloud SDK produces
 * after DoltHub wraps each statement with `Run SQL query: <sql>`).
 *
 * Without trailer parsing, cloud-side `wl done` PRs were misclassified
 * as `wanted-edit/unclaim` because the "Run SQL query: ..." subject
 * didn't match the literal CLI form, so verb detection fell through to
 * row-state inference — which, when the DML's WHERE clause silently
 * no-op'd, saw `branchStatus='open'` + `mainStatus='claimed'` and
 * inferred `unclaim`.
 */

import { describe, expect, it } from 'vitest';
import { parseCommitSubject } from './inbox-classifier';

describe('parseCommitSubject', () => {
  it('parses bare CLI subjects', () => {
    expect(parseCommitSubject('wl claim: w-abc123')).toEqual({
      kind: 'wl',
      verb: 'claim',
      itemId: 'w-abc123',
      reason: undefined,
    });
    expect(parseCommitSubject('wl done: w-abc123')).toEqual({
      kind: 'wl',
      verb: 'done',
      itemId: 'w-abc123',
      reason: undefined,
    });
  });

  it('parses bare CLI subjects with em-dash reason', () => {
    const parsed = parseCommitSubject('wl reject: w-abc123 — needs more tests');
    expect(parsed).toEqual({
      kind: 'wl',
      verb: 'reject',
      itemId: 'w-abc123',
      reason: 'needs more tests',
    });
  });

  it('parses Register rig subjects', () => {
    expect(parseCommitSubject('Register rig: alice')).toEqual({
      kind: 'register',
      handle: 'alice',
    });
  });

  it('parses single-line cloud-SDK trailers (UPDATE done DML)', () => {
    // Real shape from a cloud-issued `wl done` commit on DoltHub:
    // single-line UPDATE wrapped by "Run SQL query: ..." with our trailer
    // appended after the closing semicolon.
    const subject =
      "Run SQL query: UPDATE wanted SET status='in_review', evidence_url='https://x/y', updated_at=NOW() " +
      "WHERE id='w-c0cb3ac83ad9' AND status='claimed' AND claimed_by='jfawcett'; -- wl done: w-c0cb3ac83ad9";
    expect(parseCommitSubject(subject)).toEqual({
      kind: 'wl',
      verb: 'done',
      itemId: 'w-c0cb3ac83ad9',
      reason: undefined,
    });
  });

  it('parses multi-line cloud-SDK trailers (INSERT post DML)', () => {
    // `wl post` produces a multi-line INSERT so the trailer lands on a
    // later line of the wrapped commit message. The trailer regex uses
    // the `m` flag and an EOL/EOS anchor so it matches across lines.
    const subject =
      'Run SQL query: INSERT INTO wanted (id, title, description, project, type, priority, tags, posted_by, status, effort_level, created_at, updated_at)\n' +
      "VALUES ('w-c0cb3ac83ad9', 'Add dark mode', NULL, NULL, 'feature', 0, NULL, 'kilo-foobar', 'open', 'medium', '2026-05-18 20:08:26', '2026-05-18 20:08:26'); -- wl post: w-c0cb3ac83ad9";
    expect(parseCommitSubject(subject)).toEqual({
      kind: 'wl',
      verb: 'post',
      itemId: 'w-c0cb3ac83ad9',
      reason: undefined,
    });
  });

  it('parses multi-statement accept-upstream trailers', () => {
    const subject =
      'Run SQL query: INSERT INTO stamps (...) VALUES (...); -- wl accept-upstream: w-c0cb3ac83ad9';
    expect(parseCommitSubject(subject)).toEqual({
      kind: 'wl',
      verb: 'accept-upstream',
      itemId: 'w-c0cb3ac83ad9',
      reason: undefined,
    });
  });

  it('parses cloud-SDK reject trailer with reason', () => {
    const subject =
      "Run SQL query: DELETE FROM completions WHERE wanted_id='w-1'; -- wl reject: w-1 — try again";
    expect(parseCommitSubject(subject)).toEqual({
      kind: 'wl',
      verb: 'reject',
      itemId: 'w-1',
      reason: 'try again',
    });
  });

  it('returns kind=unknown for unrelated subjects', () => {
    expect(parseCommitSubject('Initial commit')).toEqual({
      kind: 'unknown',
      subject: 'Initial commit',
    });
    expect(parseCommitSubject('Run SQL query: SELECT 1')).toEqual({
      kind: 'unknown',
      subject: 'Run SQL query: SELECT 1',
    });
  });

  it('rejects unknown verbs in trailer form', () => {
    const subject = 'Run SQL query: UPDATE x SET y=1; -- wl frob: w-1';
    const parsed = parseCommitSubject(subject);
    expect(parsed.kind).toBe('unknown');
  });
});
