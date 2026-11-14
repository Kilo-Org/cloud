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
 * The `cliSessionsV2.get` read, narrowed to the fields that judge a link: the
 * read's own state, when it answered, and the identity it reported.
 */
type ShareRead = Readonly<{
  isError: boolean;
  isFetching: boolean;
  isPending: boolean;
  dataUpdatedAt: number;
  data: Readonly<{ public_id: string | null }> | undefined;
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
 * The read that can judge this sheet's link is one taken after the create: a
 * read older than the link cannot know it exists, and one still in flight has
 * no answer yet. Its answer either names the link this sheet made — still live
 * — or a different (or no) identity, which means the link shown was replaced
 * somewhere else. A worker older than the app answers no identity at all, so
 * there is nothing to compare and the URL is shown as it always was.
 */
function linkIsSuperseded(created: CreatedLink, read: ShareRead): boolean {
  if (created.publicId === null || read.isPending || read.isFetching) {
    return false;
  }
  return read.dataUpdatedAt > created.at && (read.data?.public_id ?? null) !== created.publicId;
}

/**
 * Which of the sheet's six states to draw. A read in error outranks the created
 * link: it cannot vouch for a URL, and the link may be dead. Until the session
 * row has been read, whether this session already has a link is unknown — and
 * treating that as "no link" offers a create action whose mutation rotates the
 * share generation and revokes the previous link.
 */
export function sharePanelOf(created: CreatedLink | null, read: ShareRead): SharePanel {
  if (read.isError) {
    return { kind: 'readFailed' };
  }
  if (created !== null) {
    return linkIsSuperseded(created, read)
      ? { kind: 'linkSuperseded' }
      : { kind: 'linkCreated', url: created.url, copy: created.copy };
  }
  if (read.isPending) {
    return { kind: 'reading' };
  }
  // Existence only: the row records that a link was issued, not whether it has
  // since expired.
  return read.data?.public_id == null ? { kind: 'noLink' } : { kind: 'linkElsewhere' };
}
