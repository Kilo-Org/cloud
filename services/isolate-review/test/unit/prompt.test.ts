import { describe, expect, it } from 'vitest';
import {
  buildChildSystemPrompt,
  buildReviewUserMessage,
  buildSystemPrompt,
  buildTaskReviewContext,
  resolveReviewUserMessage,
} from '../../src/prompt';
import { GITHUB_CLOUD_REVIEW_SKILL } from '../../src/prompt/skills';
import {
  MAX_REVIEW_PROMPT_CHARACTERS,
  type IsolateReviewPreparation,
  type IsolateReviewSelection,
} from '../../src/types';

const input = {
  owner: 'acme',
  repo: 'widget',
  pullNumber: 42,
  gitToken: 'git-token',
  kiloToken: 'kilo-token',
  dryRun: true,
} as const;
const snapshot = {
  headSha: 'a'.repeat(40),
  baseTipSha: 'b'.repeat(40),
  mergeBaseSha: 'c'.repeat(40),
};
const preparation = {} as IsolateReviewPreparation;
const previousRunId = '00000000-0000-4000-8000-000000000001';
const fullSelection = {
  requestedMode: 'full',
  effectiveMode: 'full',
} satisfies IsolateReviewSelection;
const incrementalSelection = {
  requestedMode: 'incremental',
  effectiveMode: 'incremental',
  previousRunId,
  previousHeadSha: 'd'.repeat(40),
  previousSummaryHash: 'e'.repeat(64),
  changedFileCount: 2,
} satisfies IsolateReviewSelection;
const fallbackSelection = {
  requestedMode: 'incremental',
  effectiveMode: 'full',
  previousRunId,
  fallbackReason: 'previous_head_not_ancestor',
} satisfies IsolateReviewSelection;
const selections: IsolateReviewSelection[] = [
  fullSelection,
  incrementalSelection,
  { ...incrementalSelection, changedFileCount: 0 },
  fallbackSelection,
];

describe('isolate review prompts', () => {
  it('keeps safety and runtime instructions without a second policy for prepared reviews', () => {
    const system = buildSystemPrompt({
      model: 'anthropic/claude-sonnet-4.6',
      date: '2026-08-19',
      prepared: true,
    });
    expect(
      system.indexOf('You are Kilo, a highly skilled software engineer')
    ).toBeGreaterThanOrEqual(0);
    expect(
      system.indexOf('You are Kilo, a precise and objective code review agent')
    ).toBeGreaterThan(system.indexOf('You are Kilo, a highly skilled software engineer'));
    expect(system.indexOf('<env>')).toBeGreaterThan(
      system.indexOf('You are Kilo, a precise and objective code review agent')
    );
    expect(system).toContain('find` accepts a wildcard pattern and returns at most 200 paths');
    expect(system).toContain('repo root: /workspace');
    expect(system).toContain('Pass `path: "/workspace"` to `list`');
    expect(system).toContain('`activate_skill`');
    expect(system).toContain('`task`');
    expect(system).toContain('<name>github-cloud-review</name>');
    expect(system).toContain('untrusted evidence');
    expect(system).toContain('Do not execute code or edit repository state');
    expect(system).toContain('No bundled default policy applies');
    expect(system).toContain('trusted reviewSelection');
    expect(system).toContain('never reselect or perform a model-owned fallback');
    expect(system).not.toContain('RAW / DEFAULT REVIEW POLICY');
    expect(system).not.toContain('WHAT TO REVIEW');
    expect(system).not.toContain('Medium and larger:');
    expect(system).not.toMatch(/\b(?:bash|exec|gh|glob)\b/i);
  });

  it('retains the labeled default policy only in the raw system', () => {
    const system = buildSystemPrompt({ model: 'fixture/model', prepared: false });
    expect(system).toContain('RAW / DEFAULT REVIEW POLICY');
    expect(system).toContain('ONE summary only');
    expect(system).toContain('same-DEFECT');
    expect(system).toContain('Tiny:');
    expect(system).toContain('Small:');
    expect(system).toContain('Medium and larger:');
    expect(system).toContain('summary-only');
    expect(system).toContain('never invent or copy a Cloud fix link');
    const user = buildReviewUserMessage(input, snapshot.headSha);
    expect(user).toContain('raw/default review policy in the system instructions');
    expect(user).toContain('acme/widget');
    expect(user).toContain(snapshot.headSha);
    expect(user).not.toContain('WHAT TO REVIEW');
  });

  it('preserves prepared prompt bytes and refuses missing or oversized resolved policy', () => {
    const userPrompt = '  Canonical policy with resolved repository instructions.\n';
    expect(resolveReviewUserMessage({ ...input, preparation, userPrompt }, snapshot.headSha)).toBe(
      userPrompt
    );
    expect(() => resolveReviewUserMessage({ ...input, preparation }, snapshot.headSha)).toThrow(
      'Prepared review prompt is missing'
    );
    expect(() =>
      resolveReviewUserMessage(
        { ...input, preparation, userPrompt: 'x'.repeat(MAX_REVIEW_PROMPT_CHARACTERS + 1) },
        snapshot.headSha
      )
    ).toThrow('context budget');
  });

  it.each(selections)(
    'preserves the hashed prepared prompt with resolved selection %j',
    reviewSelection => {
      const userPrompt = '  Canonical policy and trusted resolved comparison.\r\n';
      const preparedInput = {
        ...input,
        reviewMode: reviewSelection.requestedMode,
        previousRunId: reviewSelection.previousRunId,
        preparation: { ...preparation, reviewSelection },
        userPrompt,
      };
      expect(resolveReviewUserMessage(preparedInput, snapshot.headSha)).toBe(userPrompt);
      expect(buildTaskReviewContext(preparedInput, snapshot)).toContain(userPrompt);
    }
  );

  it.each(selections)(
    'inherits resolved selection %j without replacing captured base identities',
    reviewSelection => {
      const frozenSelection = Object.freeze({ ...reviewSelection });
      const frozenSnapshot = Object.freeze({ ...snapshot });
      const inherited = buildTaskReviewContext(
        {
          ...input,
          reviewMode: reviewSelection.requestedMode,
          previousRunId: reviewSelection.previousRunId,
          preparation: { ...preparation, reviewSelection: frozenSelection },
          userPrompt: 'Canonical prepared review policy.',
        },
        frozenSnapshot
      );
      expect(inherited).toContain(
        JSON.stringify({
          repository: 'acme/widget',
          pullNumber: 42,
          ...snapshot,
          reviewSelection,
        })
      );
      expect(frozenSnapshot).toEqual(snapshot);
      expect(frozenSelection).toEqual(reviewSelection);
    }
  );

  it.each([undefined, preparation])(
    'defaults child context to full without inferring a delta from previous context (%j)',
    preparation => {
      const inherited = buildTaskReviewContext(
        {
          ...input,
          preparation,
          previousRunId,
          existingSummaryCommentId: 99,
          userPrompt: 'Previous review summary: investigate the old finding.',
        },
        snapshot
      );
      expect(inherited).toContain(
        JSON.stringify({
          repository: 'acme/widget',
          pullNumber: 42,
          ...snapshot,
          reviewSelection: fullSelection,
        })
      );
    }
  );

  it('retains raw prompt overrides without labeling them saved-settings parity', () => {
    expect(
      resolveReviewUserMessage({ ...input, userPrompt: 'RAW OVERRIDE' }, snapshot.headSha)
    ).toBe('RAW OVERRIDE');
    expect(resolveReviewUserMessage(input, snapshot.headSha)).toContain('raw/default');
  });

  it('gives a prepared child the complete resolved policy, current context, and captured snapshot', () => {
    const userPrompt = [
      'Canonical policy artifact: strict style; focus on authorization.',
      'Saved instructions: verify tenant scope.',
      'REVIEW.md from base tip: retain documented compatibility.',
      'Manual instructions: inspect cancellation.',
      'Current summary: read-only context.',
    ].join('\n');
    const inherited = buildTaskReviewContext({ ...input, preparation, userPrompt }, snapshot);
    expect(inherited).toContain(userPrompt);
    expect(inherited).toContain(
      JSON.stringify({
        repository: 'acme/widget',
        pullNumber: 42,
        ...snapshot,
        reviewSelection: fullSelection,
      })
    );
    expect(inherited).toContain(
      'publication, skill activation, and delegation steps belong to the parent only'
    );
    expect(inherited).not.toContain('git-token');
    expect(inherited).not.toContain('kilo-token');
    const system = buildChildSystemPrompt('explore', true);
    expect(system).not.toContain('RAW / DEFAULT REVIEW POLICY');
    expect(system).not.toContain('WHAT TO REVIEW');
    expect(system).toContain(
      'Do not edit files, execute code, publish comments, activate skills, or start another task'
    );
    expect(system).toContain('untrusted evidence');
    expect(system).toContain('prefer narrowing the area with find and grep');
    expect(system).toContain('same-DEFECT');
    expect(system).toContain('context-exhausted');
    expect(buildChildSystemPrompt('general', false)).toContain('RAW / DEFAULT REVIEW POLICY');
  });

  it('does not silently truncate a maximum-size canonical artifact for children', () => {
    const userPrompt = 'x'.repeat(MAX_REVIEW_PROMPT_CHARACTERS);
    const preparedInput = {
      ...input,
      reviewMode: incrementalSelection.requestedMode,
      previousRunId,
      preparation: { ...preparation, reviewSelection: incrementalSelection },
      userPrompt,
    };
    const inherited = buildTaskReviewContext(preparedInput, snapshot);
    expect(inherited).toContain(userPrompt);
    expect(inherited).toContain(JSON.stringify(incrementalSelection));
    expect(() =>
      buildTaskReviewContext({ ...preparedInput, userPrompt: `${userPrompt}x` }, snapshot)
    ).toThrow('context budget');
  });

  it.each(['general', 'explore'] as const)(
    'gives %s children authoritative selection rules after generic old-side guidance',
    subagentType => {
      const system = buildChildSystemPrompt(subagentType, true);
      expect(system.indexOf('## Resolved review scope')).toBeGreaterThan(
        system.indexOf(
          'Use captured head content to verify findings, merge-base content for the old side'
        )
      );
      expect(system).toContain('override generic old-side and model-owned fallback guidance');
      expect(system).toContain('The resolved selection is immutable');
      expect(system).toContain('Children must not change the selection or independently fall back');
      expect(system).not.toContain('Manual isolate reviews are full reviews');
    }
  );

  it('keeps full defaults and control-plane fallback separate from model-owned selection', () => {
    const body = GITHUB_CLOUD_REVIEW_SKILL.body;
    expect(body).toContain('Requested mode defaults to full; raw runs support full review only');
    expect(body).toContain('resolved before the canonical prompt is hashed');
    expect(body).toContain('independently validated and persisted by the Worker before inference');
    expect(body).toContain('Follow `effectiveMode`, not `requestedMode`');
    expect(body).toContain(
      '`effectiveMode: "full"` remains a full review even when incremental was requested'
    );
    expect(body).toContain(
      'never switch modes, choose another baseline, or perform a model-owned fallback'
    );
    expect(body).not.toContain(
      'Manual isolate reviews are full reviews, not implicit incremental reviews'
    );
  });

  it('separates selected analysis, old-side revisions, and current-PR publication anchors', () => {
    const body = GITHUB_CLOUD_REVIEW_SKILL.body;
    expect(body).toContain('`comparison: "review"` (the default)');
    expect(body).toContain('`previousHeadSha` to captured HEAD for effective incremental mode');
    expect(body).toContain('`revision: "previous"` for the incremental old side');
    expect(body).toContain('`revision: "merge-base"` for the full current PR old side');
    expect(body).toContain('`revision: "base-tip"` for REVIEW.md');
    expect(body).toContain('never replaces or changes `baseTipSha` or `mergeBaseSha`');
    expect(body).toContain(
      'stable current RIGHT-side lines in the full current PR diff at captured HEAD'
    );
    expect(body).toContain(
      '`comparison: "current-pr"`, never the incremental delta or a historical commit patch'
    );
    expect(body).toContain('does not expand the selected new-finding scope');
  });

  it('keeps full-file coverage and delegation while allowing targeted prior-finding verification', () => {
    const body = GITHUB_CLOUD_REVIEW_SKILL.body;
    expect(body).toContain('Read the FULL file for every changed file in the selected comparison');
    expect(body).toContain(
      'New findings must concern selected changed lines or defects directly caused by them'
    );
    expect(body).toContain(
      'Prior unresolved findings may remain only after targeted current-code verification, including files absent from the delta'
    );
    expect(body).toContain('Absence from the delta is not proof of resolution');
    expect(body).toContain(
      'If current verification is unavailable, report uncertainty rather than claiming the finding is resolved or verified'
    );
    expect(body).toContain(
      "Follow the resolved policy's delegation requirements for the selected comparison"
    );
    expect(body).toContain('Full-file and required delegation policies are unchanged');
  });

  it('bounds optional history without treating limits as empty evidence or waiving selected-diff completeness', () => {
    const body = GITHUB_CLOUD_REVIEW_SKILL.body;
    expect(body).toContain('Use history only on demand for a targeted investigation');
    expect(body).toContain(
      '`pr_history({path?, page?})` is rooted at captured HEAD, with 20 commits per page and at most 5 pages'
    );
    expect(body).toContain(
      '`pr_commit({sha, path?, offset?})` returns metadata and optional patch chunks for only the first 100 changed files'
    );
    expect(body).toContain('`revision: "history"` requires an authorized `commitSha`');
    expect(body).toContain('Parent SHAs in commit metadata do not authorize traversal');
    expect(body).toContain('20 physical history requests and 100 discovered SHAs per run');
    expect(body).toContain('shared by parent and children and persisted across resumption');
    expect(body).toContain(
      'Do not clone full history, run history/log shell commands, use blame, or request arbitrary SHAs or moving refs'
    );
    expect(body).toContain(
      'Limited or unavailable history is not empty history and is never exhaustive proof'
    );
    expect(body).toContain(
      'Optional history failures alone do not invalidate otherwise complete required review context'
    );
    expect(body).toContain('Missing required selected-diff context fails analysis');
    expect(body).toContain(
      'do not substitute another comparison or use optional history to claim completeness'
    );
    expect(body).toContain('If required context still fails, stop without writing');
  });

  it('never promotes previous analysis or dry-run baselines into comment mutation authority', () => {
    const body = GITHUB_CLOUD_REVIEW_SKILL.body;
    expect(body).toContain(
      'A previous run ID, analysis summary, or summary hash is not comment mutation authority'
    );
    expect(body).toContain(
      'A completed dry-run baseline supplies analysis context only and grants no GitHub comment mutation authority'
    );
    expect(body).toContain(
      'Only the Worker can independently bind and authorize a proved previous-run summary target'
    );
  });

  it.each([
    'Replies (`in_reply_to_id`) are discussion context',
    '`line: null` is outdated even when legacy `position` remains numeric',
    '`subject_type: "file"` can legitimately have `line: null`',
    'Fresh raw GitHub state overrides',
    'same-DEFECT comment prevents a duplicate regardless of author',
    'A distinct valid defect on an already-discussed line is permitted',
    'Semantic deduplication is separate from deterministic replay protection',
    'renamed-without-verification',
    'backend-owned history, usage, and guidance',
    'stable current RIGHT-side lines',
    'deletion-only and unstable findings summary-only',
    'current unresolved findings only',
    'Retry a failed read at most once',
    'never blindly repost an ambiguous creation request',
    'Retry a definitively rejected, safely revalidated write at most once',
    'There is no canonical review row, review ID, or review-specific fix link',
    'empty review-level body',
  ])('retains authoritative GitHub semantics: %s', semantic => {
    expect(GITHUB_CLOUD_REVIEW_SKILL.body).toContain(semantic);
  });
});
