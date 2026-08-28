import { type CodeReviewPlatform } from '@kilocode/app-shared/code-review';
import { type ParseKeys } from 'i18next';

import type en from './locales/en.json';

type ProviderReviewKey = Extract<ParseKeys, `providerReview.${string}`>;
type RequestVocabulary = {
  readonly [Key in keyof typeof en.providerReview.pullRequest]: Extract<
    ProviderReviewKey,
    `providerReview.${'pullRequest' | 'mergeRequest'}.${Key}`
  >;
};

const pullRequest = {
  title: 'providerReview.pullRequest.title',
  open: 'providerReview.pullRequest.open',
  review: 'providerReview.pullRequest.review',
  merge: 'providerReview.pullRequest.merge',
  confirmMerge: 'providerReview.pullRequest.confirmMerge',
  paste: 'providerReview.pullRequest.paste',
  urlAccessibility: 'providerReview.pullRequest.urlAccessibility',
  clearLink: 'providerReview.pullRequest.clearLink',
  share: 'providerReview.pullRequest.share',
  badge: 'providerReview.pullRequest.badge',
  loading: 'providerReview.pullRequest.loading',
  unavailable: 'providerReview.pullRequest.unavailable',
  noReviews: 'providerReview.pullRequest.noReviews',
  noDiscussion: 'providerReview.pullRequest.noDiscussion',
} as const;

const mergeRequest = {
  title: 'providerReview.mergeRequest.title',
  open: 'providerReview.mergeRequest.open',
  review: 'providerReview.mergeRequest.review',
  merge: 'providerReview.mergeRequest.merge',
  confirmMerge: 'providerReview.mergeRequest.confirmMerge',
  paste: 'providerReview.mergeRequest.paste',
  urlAccessibility: 'providerReview.mergeRequest.urlAccessibility',
  clearLink: 'providerReview.mergeRequest.clearLink',
  share: 'providerReview.mergeRequest.share',
  badge: 'providerReview.mergeRequest.badge',
  loading: 'providerReview.mergeRequest.loading',
  unavailable: 'providerReview.mergeRequest.unavailable',
  noReviews: 'providerReview.mergeRequest.noReviews',
  noDiscussion: 'providerReview.mergeRequest.noDiscussion',
} as const;

/** Pass these keys to the active translator; do not cache translated text. */
export const PROVIDER_REVIEW_REQUEST_KEYS = {
  github: pullRequest,
  gitlab: mergeRequest,
  bitbucket: pullRequest,
} as const satisfies Record<CodeReviewPlatform, RequestVocabulary>;

/** State messages stay separate from request terminology and action availability. */
export const PROVIDER_REVIEW_STATE_KEYS = {
  title: 'providerReview.title',
  identity: {
    owner: 'providerReview.identity.owner',
    actor: 'providerReview.identity.actor',
    integration: 'providerReview.identity.integration',
    instance: 'providerReview.identity.instance',
    repository: 'providerReview.identity.repository',
    revision: 'providerReview.identity.revision',
  },
  connection: {
    connect: 'providerReview.connection.connect',
    reconnect: 'providerReview.connection.reconnect',
    expired: 'providerReview.connection.expired',
    personalBitbucket: 'providerReview.connection.personalBitbucket',
    switchOrganization: 'providerReview.connection.switchOrganization',
    loading: 'providerReview.connection.loading',
  },
  entry: {
    paste: 'providerReview.entry.paste',
    invalidLink: 'providerReview.entry.invalidLink',
    ambiguous: 'providerReview.entry.ambiguous',
    noRecents: 'providerReview.entry.noRecents',
    openProvider: 'providerReview.entry.openProvider',
  },
  inbox: {
    actorScope: 'providerReview.inbox.actorScope',
    repositoryScope: 'providerReview.inbox.repositoryScope',
    pageFailed: 'providerReview.inbox.pageFailed',
    retryPage: 'providerReview.inbox.retryPage',
  },
  files: {
    empty: 'providerReview.files.empty',
    binary: 'providerReview.files.binary',
    truncated: 'providerReview.files.truncated',
    unavailable: 'providerReview.files.unavailable',
    contextFailed: 'providerReview.files.contextFailed',
    position: 'providerReview.files.position',
  },
  checks: {
    empty: 'providerReview.checks.empty',
    unavailable: 'providerReview.checks.unavailable',
    openProvider: 'providerReview.checks.openProvider',
  },
  permission: {
    forbidden: 'providerReview.permission.forbidden',
    unsupported: 'providerReview.permission.unsupported',
    version: 'providerReview.permission.version',
    license: 'providerReview.permission.license',
    restricted: 'providerReview.permission.restricted',
    unknown: 'providerReview.permission.unknown',
    readOnly: 'providerReview.permission.readOnly',
    replaceToken: 'providerReview.permission.replaceToken',
  },
  draft: {
    stale: 'providerReview.draft.stale',
    quarantined: 'providerReview.draft.quarantined',
    emptyQueue: 'providerReview.draft.emptyQueue',
    saved: 'providerReview.draft.saved',
    refresh: 'providerReview.draft.refresh',
  },
  outcome: {
    confirmed: 'providerReview.outcome.confirmed',
    accepted: 'providerReview.outcome.accepted',
    partial: 'providerReview.outcome.partial',
    unresolved: 'providerReview.outcome.unresolved',
    retryable: 'providerReview.outcome.retryable',
    rejected: 'providerReview.outcome.rejected',
    checkStatus: 'providerReview.outcome.checkStatus',
    storageFailed: 'providerReview.outcome.storageFailed',
  },
  merge: {
    noMethods: 'providerReview.merge.noMethods',
    confirmDelete: 'providerReview.merge.confirmDelete',
    confirmKeep: 'providerReview.merge.confirmKeep',
    deleteBranch: 'providerReview.merge.deleteBranch',
    pendingTask: 'providerReview.merge.pendingTask',
    deletionFailed: 'providerReview.merge.deletionFailed',
    deletionUnknown: 'providerReview.merge.deletionUnknown',
    changedHead: 'providerReview.merge.changedHead',
  },
  gitlab: {
    approvals: 'providerReview.gitlab.approvals',
    changesRequested: 'providerReview.gitlab.changesRequested',
    changesDoNotBlock: 'providerReview.gitlab.changesDoNotBlock',
    squashPolicy: 'providerReview.gitlab.squashPolicy',
  },
  bitbucket: {
    noExpectedHeadGuard: 'providerReview.bitbucket.noExpectedHeadGuard',
    participantState: 'providerReview.bitbucket.participantState',
    noAutoMerge: 'providerReview.bitbucket.noAutoMerge',
    noBranchSync: 'providerReview.bitbucket.noBranchSync',
    noReactions: 'providerReview.bitbucket.noReactions',
  },
} as const satisfies Record<
  string,
  ProviderReviewKey | Readonly<Record<string, ProviderReviewKey>>
>;
