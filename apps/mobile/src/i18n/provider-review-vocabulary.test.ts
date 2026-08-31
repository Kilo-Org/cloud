import { CODE_REVIEW_PLATFORMS } from '@kilocode/app-shared/code-review';
import { createInstance } from 'i18next';
import { type UseTranslationResponse } from 'react-i18next';
import { describe, expect, expectTypeOf, it } from 'vitest';

import { REPO_PLATFORM_LABEL_KEYS } from '@/lib/picker-bridge';

import en from './locales/en.json';
import {
  PROVIDER_REVIEW_REQUEST_KEYS,
  PROVIDER_REVIEW_STATE_KEYS,
  type ProviderReviewKey,
} from './provider-review-vocabulary';

const i18n = createInstance();
await i18n.init({
  resources: { en: { translation: en } },
  lng: 'en',
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
  initAsync: false,
  returnNull: false,
});

const pullRequestCopy = {
  title: 'Pull request review',
  open: 'Open pull request',
  review: 'Review pull request',
  merge: 'Merge pull request',
  confirmMerge: 'Merge pull request?',
  paste: 'Paste a pull request link',
  urlAccessibility: 'Pull request URL',
  clearLink: 'Clear pull request link',
  share: 'Share pull request',
  badge: 'Pull request #42',
  loading: 'Loading pull request',
  unavailable: 'This pull request is unavailable. Check the link and your repository access.',
  noReviews: 'No pull requests in this scope. Paste a link or select a repository.',
  noDiscussion: 'No discussion on this pull request yet. You can add a comment.',
};
const mergeRequestCopy = {
  title: 'Merge request review',
  open: 'Open merge request',
  review: 'Review merge request',
  merge: 'Merge merge request',
  confirmMerge: 'Merge merge request?',
  paste: 'Paste a merge request link',
  urlAccessibility: 'Merge request URL',
  clearLink: 'Clear merge request link',
  share: 'Share merge request',
  badge: 'Merge request !42',
  loading: 'Loading merge request',
  unavailable: 'This merge request is unavailable. Check the link and your repository access.',
  noReviews: 'No merge requests in this scope. Paste a link or select a repository.',
  noDiscussion: 'No discussion on this merge request yet. You can add a comment.',
};
const expectedRequestCopy = {
  github: pullRequestCopy,
  gitlab: mergeRequestCopy,
  bitbucket: pullRequestCopy,
};

type StringTree = { [key: string]: string | StringTree };

function leafEntries(tree: StringTree, prefix = ''): [string, string][] {
  return Object.entries(tree).flatMap(([name, value]) => {
    const path = prefix ? `${prefix}.${name}` : name;
    return typeof value === 'string' ? [[path, value]] : leafEntries(value, path);
  });
}

describe('provider review vocabulary', () => {
  it('keeps vocabulary inputs constrained to catalog leaves', () => {
    const key = PROVIDER_REVIEW_REQUEST_KEYS.gitlab.title satisfies ProviderReviewKey;

    expectTypeOf<ProviderReviewKey>().not.toBeNever();
    expectTypeOf<'providerReview.title'>().toExtend<ProviderReviewKey>();
    expectTypeOf<'providerReview.permission.forbidden'>().toExtend<ProviderReviewKey>();
    expectTypeOf<'providerReview.mergeRequest.unknown'>().not.toExtend<ProviderReviewKey>();
    expectTypeOf<'providerReview'>().not.toExtend<ProviderReviewKey>();
    expectTypeOf<'providerReview.mergeRequest'>().not.toExtend<ProviderReviewKey>();
    expectTypeOf<'providerReview.permission'>().not.toExtend<ProviderReviewKey>();
    expectTypeOf<'common.cancel'>().not.toExtend<ProviderReviewKey>();
    expectTypeOf<`providerReview.${string}`>().not.toExtend<ProviderReviewKey>();
    expectTypeOf<string>().not.toExtend<ProviderReviewKey>();
    expect(i18n.t(key)).toBe('Merge request review');
  });

  it('keeps legacy string inputs usable with the instance translator', () => {
    const translate = (key: string) => i18n.t(key);
    const label = translate('common.cancel');

    expectTypeOf(label).toEqualTypeOf<string>();
    expect(label).toBe('Cancel');
  });

  it('keeps widened repository labels usable with the hook translator', () => {
    const translate = (t: UseTranslationResponse<'translation', undefined>['t']) =>
      t(REPO_PLATFORM_LABEL_KEYS.gitlab);
    const label = translate(i18n.t);

    expectTypeOf(label).toEqualTypeOf<string>();
    expect(`${label}: example/repo`).toBe('GitLab: example/repo');
  });

  it.each(CODE_REVIEW_PLATFORMS)('renders the request terminology for %s', provider => {
    const rendered = Object.fromEntries(
      Object.entries(PROVIDER_REVIEW_REQUEST_KEYS[provider]).map(([field, key]) => [
        field,
        i18n.t(key, { number: 42 }),
      ])
    );

    expect(rendered).toEqual(expectedRequestCopy[provider]);
  });

  it('resolves exactly the English providerReview leaves without missing or extra keys', () => {
    const keys = new Set(
      [
        ...leafEntries(PROVIDER_REVIEW_REQUEST_KEYS),
        ...leafEntries(PROVIDER_REVIEW_STATE_KEYS),
      ].map(([, key]) => key)
    );
    const resolved = Object.fromEntries(
      [...keys].map(key => [key, i18n.getResource('en', 'translation', key)])
    );

    expect(resolved).toStrictEqual(
      Object.fromEntries(leafEntries(en.providerReview, 'providerReview'))
    );
  });

  it('keeps permission failures distinct from provider limitations and recovery labels', () => {
    const rendered = Object.fromEntries(
      Object.entries(PROVIDER_REVIEW_STATE_KEYS.permission).map(([state, key]) => [
        state,
        i18n.t(key, { reason: 'Repository policy.' }),
      ])
    );

    expect(rendered).toEqual({
      forbidden: 'You do not have permission to perform this action. Repository policy.',
      unsupported: 'This provider does not support this action. Repository policy.',
      version: 'This action is unavailable on this provider version. Repository policy.',
      license: 'This action requires a different provider license. Repository policy.',
      restricted: 'A current repository restriction blocks this action. Repository policy.',
      unknown: 'The connection has not confirmed whether this action is available.',
      readOnly: 'You can read this review. This connection needs additional permission to write.',
      replaceToken: 'Replace the connection token',
    });
  });

  it('preserves stale draft positions and keeps unresolved identities quarantined', () => {
    const { draft } = PROVIDER_REVIEW_STATE_KEYS;

    expect(i18n.t(draft.stale)).toBe(
      'The revision changed. Your text and original position are saved. Refresh before choosing a new position.'
    );
    expect(i18n.t(draft.quarantined)).toBe(
      'This saved draft has an unresolved account or repository identity. It has not been attached to this review.'
    );
    expect(i18n.t(draft.refresh)).toBe('Refresh review');
  });

  it('distinguishes confirmed, pending, partial, retryable, and rejected outcomes', () => {
    const rendered = Object.fromEntries(
      Object.entries(PROVIDER_REVIEW_STATE_KEYS.outcome).map(([state, key]) => [
        state,
        i18n.t(key, {
          provider: 'Bitbucket',
          confirmed: 2,
          unfinished: 1,
          reason: 'Access denied.',
        }),
      ])
    );

    expect(rendered).toEqual({
      confirmed: 'Bitbucket confirmed this action.',
      accepted: 'Bitbucket accepted this action. Completion is not confirmed yet.',
      partial: 'Confirmed: 2. Unfinished: 1. Your remaining work is saved.',
      unresolved: 'The outcome is unknown. Check the status before sending anything again.',
      retryable: 'The action did not start. Your work is saved. You can retry the same action.',
      rejected: 'The action was rejected. Your work is saved. Access denied.',
      checkStatus: 'Check action status',
      storageFailed:
        'Could not save this action safely. Nothing was sent. Your text is still here.',
    });
  });

  it('does not present missing checks or an empty comment queue as completed work', () => {
    expect(i18n.t(PROVIDER_REVIEW_STATE_KEYS.checks.empty)).toBe(
      'No checks reported. This does not mean the checks passed.'
    );
    expect(i18n.t(PROVIDER_REVIEW_STATE_KEYS.draft.emptyQueue)).toBe(
      'No comments queued. Add a comment or a review summary.'
    );
  });

  it('preserves provider limits and separates merge completion from branch deletion', () => {
    const { bitbucket, gitlab, merge } = PROVIDER_REVIEW_STATE_KEYS;

    expect(i18n.t(gitlab.approvals, { displayCount: '2' })).toBe('Approvals needed: 2');
    expect(i18n.t(gitlab.changesDoNotBlock)).toBe(
      'Requested changes are recorded, but this instance does not enforce them as a merge block.'
    );
    expect(i18n.t(bitbucket.noExpectedHeadGuard)).toBe(
      'Bitbucket cannot atomically bind this action to the reviewed revision. Head checks detect changes but cannot prevent a concurrent update.'
    );
    expect(i18n.t(merge.pendingTask)).toBe(
      'The merge task is still running. You can leave and check its status later.'
    );
    expect(i18n.t(merge.deletionFailed, { reason: 'Protected branch.' })).toBe(
      'The merge is confirmed, but branch deletion failed. Protected branch.'
    );
    expect(i18n.t(merge.deletionUnknown)).toBe(
      'The merge is confirmed. Branch deletion is not confirmed.'
    );
  });
});
