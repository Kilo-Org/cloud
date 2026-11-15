import { readTrpcErrorField } from '@/lib/trpc-error';

import { type ShareCopyState } from './session-share-active-link';

/** A link this sheet created, and what is known about it. */
export type CreatedLink = {
  readonly url: string;
  /**
   * The identity the worker created. `null` while a web server older than this
   * response field answers, whose reply carries the token alone.
   */
  readonly publicId: string | null;
  /** When the create landed, so a read that started before it cannot judge the link. */
  readonly at: number;
  readonly copy: ShareCopyState;
};

/**
 * What the sheet offers, as one state rather than a URL plus four booleans.
 *
 * `linkSuperseded` is the case the old shape could not name: this sheet's URL is
 * no longer the live one — another device replaced it — so Copy and Share would
 * hand out a dead link. It keeps Revoke, which revokes the **current** link, and
 * says so.
 */
export type SharePanel =
  | { readonly kind: 'reading' }
  | { readonly kind: 'readFailed' }
  | { readonly kind: 'noLink' }
  | { readonly kind: 'linkElsewhere' }
  | { readonly kind: 'linkCreated'; readonly url: string; readonly copy: ShareCopyState }
  | { readonly kind: 'linkSuperseded' };

/**
 * What the read taken just before Copy or Share proved about the created link.
 *
 * `unchecked` is the start, and every link a web server without the capability
 * field created stays there: with no identity there is nothing to compare.
 * `current` names the identity the create returned; `superseded` names another
 * one (or none), so the URL is dead; `readFailed` did not settle, so the sheet
 * cannot vouch for the URL.
 */
export type ShareFreshness =
  | { readonly kind: 'unchecked' }
  | { readonly kind: 'current' }
  | { readonly kind: 'superseded' }
  | { readonly kind: 'readFailed' };

/** The read fields that judge a link by the identity it reports. */
type ShareIdentityRead = Readonly<{
  isError: boolean;
  data: Readonly<{ public_id: string | null }> | undefined;
}>;

/**
 * The `cliSessionsV2.get` read, narrowed to the fields that judge a link: the
 * read's own state, when it answered, and the identity it reported.
 */
type ShareRead = ShareIdentityRead &
  Readonly<{
    isFetching: boolean;
    isPending: boolean;
    dataUpdatedAt: number;
  }>;

/**
 * The message to show for a failed share action: the server's own wording when
 * it has one, and the caller's fallback when it does not. A worker error such
 * as the payload-too-large refusal is the useful part, so it wins.
 */
export function actionErrorMessage(error: unknown, fallback: string): string {
  const message = readTrpcErrorField(error, 'message')?.trim();
  return message !== undefined && message.length > 0 ? message : fallback;
}

/*
 * The read taken at a press, which is the only one that can judge distribution:
 * the sheet can stay open while another device rotates the link, and a cached
 * row never schedules a read of its own. Its answer either names the capability
 * this sheet created — still live — or another (or no) identity, which means
 * the URL is dead. A created link with no identity cannot be compared, so it
 * stays `unchecked` and distributes as it always did.
 */
export function freshnessOf(created: CreatedLink, read: ShareIdentityRead): ShareFreshness {
  if (created.publicId === null) {
    return { kind: 'unchecked' };
  }
  if (read.isError) {
    return { kind: 'readFailed' };
  }
  return (read.data?.public_id ?? null) === created.publicId
    ? { kind: 'current' }
    : { kind: 'superseded' };
}

/*
 * The read that can judge this sheet's link is one taken after the create: a
 * read older than the link cannot know it exists, and one still in flight has
 * no answer yet. Its answer either names the link this sheet made — still live
 * — or a different (or no) identity, which means the link shown was replaced
 * somewhere else. A worker older than the app answers no identity at all, so
 * there is nothing to compare and the URL is shown as it always was.
 */
function linkIsSuperseded(created: CreatedLink, read: ShareRead): boolean {
  if (created.publicId === null || read.isPending || read.isFetching || read.isError) {
    return false;
  }
  return read.dataUpdatedAt > created.at && (read.data?.public_id ?? null) !== created.publicId;
}

/**
 * Failed background reads do not invalidate a created capability. Distribution
 * is gated by the press-time read. Without a created link, a failed session
 * read offers Retry rather than rotating a link whose identity is unknown.
 */
export function sharePanelOf(
  created: CreatedLink | null,
  read: ShareRead,
  freshness: ShareFreshness
): SharePanel {
  if (created !== null) {
    if (freshness.kind === 'superseded') {
      return { kind: 'linkSuperseded' };
    }
    if (freshness.kind === 'readFailed') {
      return { kind: 'readFailed' };
    }
    return linkIsSuperseded(created, read)
      ? { kind: 'linkSuperseded' }
      : { kind: 'linkCreated', url: created.url, copy: created.copy };
  }
  if (read.isError) {
    return { kind: 'readFailed' };
  }
  if (read.isPending) {
    return { kind: 'reading' };
  }
  // Existence only: the row records that a link was issued, not whether it has
  // since expired.
  return read.data?.public_id == null ? { kind: 'noLink' } : { kind: 'linkElsewhere' };
}
