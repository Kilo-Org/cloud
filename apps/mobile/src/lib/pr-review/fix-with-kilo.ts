// "Fix with Kilo" for one PR/MR comment: the provider's own anchor for the
// comment, the message that carries it, and the new-session route that
// delivers it.
//
// All four functions are pure. The press is pure navigation — no network
// call, no mutation — so there is nothing to retry and no failure state to
// render here. The one non-retryable case (a comment with no addressable
// web URL) resolves to `null`, and the caller renders no CTA at all.
//
// Delivery reuses the existing share-payload channel: the caller stages
// `{ text, files: [], failedFiles: [] }` under a fresh `shareId` and pushes
// `buildFixWithKiloHref`, whose `shareId` makes the new-session composer
// render the staged text on its first render.

import {
  type ProviderPrPlatform,
  type ProviderPrRef,
  providerPrRepoPath,
  providerPrWebUrl,
} from './provider-pr-ref';

import { appendNewSessionPrefill } from '@/components/agents/new-session-prefill';
import { getNewAgentSessionPath } from '@/components/agents/session-list-routes';
import { i18n } from '@/i18n';
import { type Href } from 'expo-router';

/**
 * Where a comment lives on the provider's page. The provider's own read
 * model folds both into one `commentId`, so the anchor is the only thing
 * that still needs the distinction.
 */
export type PrCommentKind = 'review' | 'conversation';

/**
 * The fragment the provider's own page uses for one comment, or `null` when
 * `commentId` is not a positive safe integer (the provider ids reach mobile
 * through a normalization step that can fold a non-numeric id, and a
 * fractional or negative value names nothing).
 */
export function prCommentAnchor(
  platform: ProviderPrPlatform,
  kind: PrCommentKind,
  commentId: number
): string | null {
  if (!Number.isSafeInteger(commentId) || commentId <= 0) {
    return null;
  }
  if (platform === 'github') {
    // GitHub's own two shapes: a review thread comment and a conversation
    // comment are different pages of the same URL space.
    return kind === 'review' ? `discussion_r${commentId}` : `issuecomment-${commentId}`;
  }
  if (platform === 'gitlab') {
    // GitLab notes, review discussion and conversation alike.
    return `note_${commentId}`;
  }
  // Bitbucket Cloud comments.
  return `comment-${commentId}`;
}

/**
 * The provider page URL for one comment, anchored. `null` when either half
 * is unavailable: a GitLab MR deep-linked with no instance hint has no host
 * to name, and `providerPrWebUrl` deliberately refuses to guess gitlab.com.
 */
export function prCommentWebUrl(
  ref: ProviderPrRef,
  kind: PrCommentKind,
  commentId: number
): string | null {
  const base = providerPrWebUrl(ref);
  const anchor = prCommentAnchor(ref.platform, kind, commentId);
  if (base === null || anchor === null) {
    return null;
  }
  return `${base}#${anchor}`;
}

/**
 * The `owner/repo` prefill for the new-session repository picker, or `null`
 * when the picker could never show it. `resolvePrefillRepoSelection` matches
 * only a `platform: 'github'` row, so pre-filling a GitLab or Bitbucket path
 * would raise `agentChat.newSession.prefillRepoUnavailable` for a repository
 * the picker can never select.
 */
export function fixWithKiloPrefillRepo(ref: ProviderPrRef): string | null {
  return ref.platform === 'github' ? providerPrRepoPath(ref) : null;
}

/** The composer message that hands Kilo the comment link to work from. */
export function fixWithKiloMessage(commentUrl: string): string {
  return i18n.t('prReview.discussion.fixWithKiloPrompt', { link: commentUrl });
}

/**
 * The new-session route that delivers the pre-written message: the staged
 * payload is keyed by `shareId`, and the composer reads it on first render.
 */
export function buildFixWithKiloHref(input: {
  shareId: string;
  organizationId: string | null;
  repo: string | null;
}): Href {
  const base = getNewAgentSessionPath(input.organizationId);
  const separator = base.includes('?') ? '&' : '?';
  const withShare = `${base}${separator}shareId=${encodeURIComponent(input.shareId)}`;
  return appendNewSessionPrefill(withShare, input.repo ? { repo: input.repo } : {}) as Href;
}
