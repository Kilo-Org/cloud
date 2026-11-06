/* eslint-disable max-lines -- the mergeability selector, the blocked-row selectors and the allowed-method list share one pure module. */
import { afterEach, describe, expect, it } from 'vitest';

import { CATALOG_LOADERS } from '@/i18n/catalogs';
import { SUPPORTED_LANGUAGES } from '@/i18n/languages';
import { i18n } from '@/i18n';

import {
  defaultMergeMethodFor,
  getAllowedMergeMethods,
  getMergeabilityStatus,
  getMergeBlockedReasons,
  type MergeBlockedReasonsArgs,
  prMergeMethodName,
} from './merge-blocked-reasons';

/** The merge copy a catalog must carry for this helper to name a method. */
type MergeCatalog = {
  prReview: {
    merge: {
      autoMergeDescription: string;
      methods: Record<'merge' | 'squash' | 'rebase', string>;
    };
  };
};

const MERGE_METHODS = ['merge', 'squash', 'rebase'] as const;

function repo(overrides: Partial<MergeBlockedReasonsArgs> = {}): MergeBlockedReasonsArgs {
  return {
    state: 'open',
    draft: false,
    mergeable: false,
    mergeableState: 'blocked',
    reviewDecision: 'REVIEW_REQUIRED',
    failedCheckCount: 0,
    allowUpdateBranch: true,
    ...overrides,
  };
}

describe('getMergeabilityStatus', () => {
  it('returns terminal for merged PRs', () => {
    expect(
      getMergeabilityStatus({ state: 'merged', mergeable: true, mergeableState: 'clean' })
    ).toBe('terminal');
  });

  it('returns terminal for closed PRs', () => {
    expect(
      getMergeabilityStatus({ state: 'closed', mergeable: true, mergeableState: 'clean' })
    ).toBe('terminal');
  });

  it('returns unknown when mergeable is null', () => {
    expect(getMergeabilityStatus({ state: 'open', mergeable: null, mergeableState: 'clean' })).toBe(
      'unknown'
    );
  });

  it('returns unknown when mergeableState is null', () => {
    expect(getMergeabilityStatus({ state: 'open', mergeable: true, mergeableState: null })).toBe(
      'unknown'
    );
  });

  it('returns unknown when mergeableState is "unknown"', () => {
    expect(
      getMergeabilityStatus({ state: 'open', mergeable: true, mergeableState: 'unknown' })
    ).toBe('unknown');
  });

  it('returns mergeable only when mergeable=true AND mergeableState=clean', () => {
    expect(getMergeabilityStatus({ state: 'open', mergeable: true, mergeableState: 'clean' })).toBe(
      'mergeable'
    );
  });

  it('returns blocked when mergeable=true but state is not clean', () => {
    expect(getMergeabilityStatus({ state: 'open', mergeable: true, mergeableState: 'dirty' })).toBe(
      'blocked'
    );
  });

  it('returns blocked when mergeable=false even with a clean state (race)', () => {
    expect(
      getMergeabilityStatus({ state: 'open', mergeable: false, mergeableState: 'clean' })
    ).toBe('blocked');
  });
});

describe('getMergeBlockedReasons', () => {
  it('returns an empty list for merged/closed PRs', () => {
    expect(
      getMergeBlockedReasons(repo({ state: 'merged', mergeable: false, mergeableState: 'clean' }))
    ).toEqual([]);
    expect(
      getMergeBlockedReasons(repo({ state: 'closed', mergeable: false, mergeableState: 'clean' }))
    ).toEqual([]);
  });

  it('reports dirty as a destructive conflicts reason', () => {
    const reasons = getMergeBlockedReasons(
      repo({ mergeable: false, mergeableState: 'dirty', reviewDecision: 'APPROVED' })
    );
    expect(reasons).toHaveLength(1);
    expect(reasons[0]?.id).toBe('conflicts');
    expect(reasons[0]?.iconKind).toBe('conflicts');
    expect(reasons[0]?.severity).toBe('destructive');
  });

  it('reports blocked with required-reviews + failing-checks when both hold', () => {
    const reasons = getMergeBlockedReasons(
      repo({ mergeable: false, mergeableState: 'blocked', failedCheckCount: 2 })
    );
    expect(reasons.map(r => r.id)).toEqual(['required-reviews', 'failing-checks']);
    expect(reasons[0]?.iconKind).toBe('required-reviews');
    expect(reasons[0]?.severity).toBe('warn');
    expect(reasons[1]?.iconKind).toBe('failing-checks');
    expect(reasons[1]?.severity).toBe('destructive');
  });

  it('leaves the failing-checks row out while the Checks card counts no failure', () => {
    const reasons = getMergeBlockedReasons(
      repo({
        mergeable: false,
        mergeableState: 'blocked',
        reviewDecision: 'CHANGES_REQUESTED',
        failedCheckCount: 0,
      })
    );
    expect(reasons.map(r => r.id)).toEqual(['required-reviews']);
  });

  it('leaves the required-reviews row out while the review decision is approved', () => {
    const reasons = getMergeBlockedReasons(
      repo({
        mergeable: false,
        mergeableState: 'blocked',
        reviewDecision: 'APPROVED',
        failedCheckCount: 1,
      })
    );
    expect(reasons.map(r => r.id)).toEqual(['failing-checks']);
  });

  it('falls back to the reported state when neither gate explains a blocked PR', () => {
    const reasons = getMergeBlockedReasons(
      repo({
        mergeable: false,
        mergeableState: 'blocked',
        reviewDecision: 'APPROVED',
        failedCheckCount: 0,
      })
    );
    expect(reasons).toHaveLength(1);
    expect(reasons[0]?.id).toBe('unknown-state');
    expect(reasons[0]?.title).toBe('This pull request is not mergeable yet');
    expect(reasons[0]?.detail).toContain('blocked');
  });

  it('falls back to the reported state when the checks read failed', () => {
    const reasons = getMergeBlockedReasons(
      repo({
        mergeable: false,
        mergeableState: 'blocked',
        reviewDecision: 'APPROVED',
        failedCheckCount: null,
      })
    );
    expect(reasons.map(r => r.id)).toEqual(['unknown-state']);
  });

  it('keeps the reviews row when the checks read failed', () => {
    const reasons = getMergeBlockedReasons(
      repo({
        mergeable: false,
        mergeableState: 'blocked',
        reviewDecision: 'REVIEW_REQUIRED',
        failedCheckCount: null,
      })
    );
    expect(reasons.map(r => r.id)).toEqual(['required-reviews']);
  });

  it('reports behind as a branch-out-of-date reason with a rebase/update CTA', () => {
    const reasons = getMergeBlockedReasons(
      repo({ mergeable: false, mergeableState: 'behind', reviewDecision: 'APPROVED' })
    );
    expect(reasons).toHaveLength(1);
    expect(reasons[0]?.id).toBe('behind');
    expect(reasons[0]?.iconKind).toBe('behind');
    expect(reasons[0]?.detail).toContain('Update the branch from the base');
  });

  it('shows a rebase-only detail when the repo disallows Update branch', () => {
    const reasons = getMergeBlockedReasons(
      repo({
        mergeable: false,
        mergeableState: 'behind',
        reviewDecision: 'APPROVED',
        allowUpdateBranch: false,
      })
    );
    expect(reasons[0]?.detail).toContain('Rebase or update the branch');
  });

  it('reports unstable as a non-required-checks-failing info reason', () => {
    const reasons = getMergeBlockedReasons(
      repo({ mergeable: true, mergeableState: 'unstable', reviewDecision: 'APPROVED' })
    );
    expect(reasons).toHaveLength(1);
    expect(reasons[0]?.id).toBe('unstable-checks');
    expect(reasons[0]?.iconKind).toBe('unstable-checks');
    expect(reasons[0]?.severity).toBe('info');
  });

  it('reports draft as a draft info reason', () => {
    const reasons = getMergeBlockedReasons(
      repo({ mergeable: false, mergeableState: 'draft', reviewDecision: null })
    );
    expect(reasons).toHaveLength(1);
    expect(reasons[0]?.id).toBe('draft');
    expect(reasons[0]?.iconKind).toBe('draft');
    expect(reasons[0]?.severity).toBe('info');
  });

  it('adds a required-reviews reason when reviewDecision is REVIEW_REQUIRED and mergeableState did not include it', () => {
    const reasons = getMergeBlockedReasons(
      repo({ mergeable: false, mergeableState: 'dirty', reviewDecision: 'REVIEW_REQUIRED' })
    );
    expect(reasons.map(r => r.id)).toEqual(['conflicts', 'required-reviews']);
  });

  it('does not double-list required-reviews when mergeableState=blocked already produced it', () => {
    const reasons = getMergeBlockedReasons(
      repo({ mergeable: false, mergeableState: 'blocked', reviewDecision: 'REVIEW_REQUIRED' })
    );
    expect(reasons.filter(r => r.id === 'required-reviews')).toHaveLength(1);
  });

  it('adds a draft reason when the PR is marked draft and mergeableState did not already report it', () => {
    const reasons = getMergeBlockedReasons(
      repo({ mergeable: false, mergeableState: 'dirty', draft: true, reviewDecision: 'APPROVED' })
    );
    expect(reasons.map(r => r.id)).toEqual(['conflicts', 'draft']);
  });

  it('does not double-list draft when mergeableState=draft already produced it', () => {
    const reasons = getMergeBlockedReasons(
      repo({ mergeable: false, mergeableState: 'draft', draft: true, reviewDecision: 'APPROVED' })
    );
    expect(reasons.filter(r => r.id === 'draft')).toHaveLength(1);
  });

  it('returns an unknown-state reason when mergeableState is unknown', () => {
    const reasons = getMergeBlockedReasons(
      repo({ mergeable: true, mergeableState: 'unknown', reviewDecision: 'APPROVED' })
    );
    expect(reasons).toHaveLength(1);
    expect(reasons[0]?.id).toBe('unknown-state');
    expect(reasons[0]?.iconKind).toBe('unknown-state');
  });

  it('returns an unknown-state reason when mergeableState is null', () => {
    const reasons = getMergeBlockedReasons(
      repo({ mergeable: true, mergeableState: null, reviewDecision: 'APPROVED' })
    );
    expect(reasons[0]?.id).toBe('unknown-state');
  });

  it('returns an empty list for a fully mergeable PR', () => {
    expect(
      getMergeBlockedReasons(
        repo({ mergeable: true, mergeableState: 'clean', reviewDecision: 'APPROVED' })
      )
    ).toEqual([]);
  });

  it('surfaces unknown future mergeableState values rather than hiding the block', () => {
    const reasons = getMergeBlockedReasons(
      repo({ mergeable: false, mergeableState: 'some_future_value', reviewDecision: 'APPROVED' })
    );
    expect(reasons).toHaveLength(1);
    expect(reasons[0]?.detail).toContain('some_future_value');
  });
});

describe('getAllowedMergeMethods', () => {
  it('returns methods in a stable order, filtering out disabled ones', () => {
    expect(
      getAllowedMergeMethods({
        allowMergeCommit: true,
        allowSquashMerge: true,
        allowRebaseMerge: true,
        allowAutoMerge: true,
        deleteBranchOnMerge: true,
        allowUpdateBranch: true,
        viewerCanPush: true,
        viewerCanAdmin: true,
      })
    ).toEqual(['merge', 'squash', 'rebase']);

    expect(
      getAllowedMergeMethods({
        allowMergeCommit: false,
        allowSquashMerge: true,
        allowRebaseMerge: false,
        allowAutoMerge: true,
        deleteBranchOnMerge: true,
        allowUpdateBranch: true,
        viewerCanPush: true,
        viewerCanAdmin: true,
      })
    ).toEqual(['squash']);

    expect(
      getAllowedMergeMethods({
        allowMergeCommit: false,
        allowSquashMerge: false,
        allowRebaseMerge: false,
        allowAutoMerge: true,
        deleteBranchOnMerge: true,
        allowUpdateBranch: true,
        viewerCanPush: true,
        viewerCanAdmin: true,
      })
    ).toEqual([]);
  });
});

describe('defaultMergeMethodFor', () => {
  it('prefers squash when the repo only allows squash', () => {
    expect(
      defaultMergeMethodFor({
        allowMergeCommit: false,
        allowSquashMerge: true,
        allowRebaseMerge: false,
        allowAutoMerge: true,
        deleteBranchOnMerge: true,
        allowUpdateBranch: true,
        viewerCanPush: true,
        viewerCanAdmin: true,
      })
    ).toBe('squash');
  });

  it('falls back to merge when the repo has no allowed methods', () => {
    expect(
      defaultMergeMethodFor({
        allowMergeCommit: false,
        allowSquashMerge: false,
        allowRebaseMerge: false,
        allowAutoMerge: true,
        deleteBranchOnMerge: true,
        allowUpdateBranch: true,
        viewerCanPush: true,
        viewerCanAdmin: true,
      })
    ).toBe('merge');
  });
});

describe('prMergeMethodName', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('names the method from the active catalog, never the wire code', async () => {
    await i18n.changeLanguage('ps');
    expect(prMergeMethodName('squash')).toBe('د کمېټونو یو کول');
    expect(prMergeMethodName('merge')).toBe('یوځای کول');
    expect(prMergeMethodName('rebase')).toBe('بیا بنسټول');
  });

  it('accepts the upper-case method codes the GraphQL API returns', async () => {
    await i18n.changeLanguage('en');
    expect(prMergeMethodName('SQUASH')).toBe('Squash');
    expect(prMergeMethodName('Merge')).toBe('Merge');
  });

  it('keeps a value this build does not know as the provider sent it', () => {
    expect(prMergeMethodName('FastForward')).toBe('FastForward');
  });

  // The sentence exists in every catalog and the label is what fills it, so a
  // catalog that kept the wire code would still read as Latin text.
  it('has a name of its own in every catalog', () => {
    const untranslated: string[] = [];
    const leftoverPlaceholders: string[] = [];
    for (const language of SUPPORTED_LANGUAGES) {
      const { prReview } = CATALOG_LOADERS[language]() as unknown as MergeCatalog;
      for (const method of MERGE_METHODS) {
        const name = prReview.merge.methods[method];
        if (name.trim() === '' || (language !== 'en' && name.toLowerCase() === method)) {
          untranslated.push(`${language}:${method}`);
        }
        const sentence = prReview.merge.autoMergeDescription.replace('{{method}}', name);
        if (sentence.includes('{{') || sentence.includes('}}')) {
          leftoverPlaceholders.push(language);
        }
      }
    }
    expect(untranslated).toEqual([]);
    expect(leftoverPlaceholders).toEqual([]);
  });
});
