import { anchorPosition } from '@kilocode/app-shared/universal-links';
import type { PreparationAttempt, SessionCommit } from '@kilocode/cloud-agent-sdk';
import type { StoredMessage } from './types';
import { groupConversationMessages } from './message-presentation';

/**
 * Where a resumed transcript should land, resolved against the rendered
 * conversation groups. `groupIndex` is the group the anchor belongs to and
 * `selectorIds` are the ids to look up in the DOM, nearest first: the anchor
 * group's first message id — the id that group's rendered content carries in
 * `data-message-id`, so an anchor sitting mid-group lands on the group's start
 * — followed by the first id of every group after it.
 *
 * The later ids are not decoration: a group can render no element at all (an
 * assistant turn whose parts are all invisible), and such a group must not read
 * as "the anchor has not loaded yet". The caller probes `selectorIds` in order
 * and uses the nearest group that did render.
 */
export type ResumeAnchor = {
  /** Index into the rendered conversation groups. */
  readonly groupIndex: number;
  /** `data-message-id` values to probe for the scroll target, nearest first. */
  readonly selectorIds: readonly string[];
};

/**
 * Resolve a stored anchor against the message ids the transcript has grouped
 * for rendering. Null when the anchor is absent from those ids — the caller
 * then loads an older page, and gives up if it never appears.
 *
 * `groups` holds each rendered group's message ids in server order; the flat
 * order of `groups` is the same order `anchorPosition` expects.
 */
export function resumeAnchor(
  groups: readonly (readonly string[])[],
  anchorMessageId: string | null | undefined
): ResumeAnchor | null {
  const position = anchorPosition(groups.flat(), anchorMessageId ?? '');
  if (position === null) {
    return null;
  }

  let offset = 0;
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    const group = groups[groupIndex];
    if (group.length === 0) {
      continue;
    }
    if (position < offset + group.length) {
      return {
        groupIndex,
        selectorIds: groups
          .slice(groupIndex)
          .map(candidate => candidate[0])
          .filter((id): id is string => Boolean(id)),
      };
    }
    offset += group.length;
  }

  return null;
}

/**
 * Resolve the anchor against the transcript's own grouping. This has to be the
 * renderer's grouping — the same messages, preparation rows AND commit anchors
 * (`commitsAfterMessage`) — or a group boundary the renderer sees does not
 * exist here: a commit anchored between two assistant messages would leave the
 * resume's groups merged, and the anchor would land on an earlier rendered
 * group than the one it belongs to.
 */
export function resumeAnchorForTranscript(
  messages: readonly StoredMessage[],
  preparationByMessageId: ReadonlyMap<string, readonly PreparationAttempt[]>,
  commitsAfterMessage: ReadonlyMap<string, readonly SessionCommit[]>,
  anchorMessageId: string | null | undefined
): ResumeAnchor | null {
  const groups = groupConversationMessages(
    [...messages],
    preparationByMessageId,
    commitsAfterMessage
  );
  return resumeAnchor(
    groups.map(group => group.map(message => message.info.id)),
    anchorMessageId
  );
}

/** What a resume attempt does next. */
export type ResumeAttemptStep = 'scroll' | 'load-older' | 'follow-tail' | 'wait';

/**
 * Decide one resume attempt. `follow-tail` is the give-up: the transcript opens
 * exactly as an anchor-less link does, at the bottom and following new output,
 * instead of staying paused at its oldest loaded message with follow off.
 *
 * An anchor that resolved inside the loaded window but drew no element cannot
 * be reached by an older page — an all-invisible assistant turn renders
 * nothing by design — and a failed older page ends the attempt too: the resume
 * is one-shot, so waiting on that failure would never complete or give up. A
 * page still in flight (a retry of a failed one included) is not a failure and
 * is waited for, and the page bound is only consulted once it has landed: the
 * bound would otherwise abandon the last allowed page the moment it was
 * requested — see the check order below.
 */
export function planResumeAttempt({
  anchorRendered,
  anchorResolved,
  attempts,
  maxOlderPages,
  hasOlderMessages,
  isLoadingOlderMessages,
  hasOlderMessagesError,
}: {
  anchorRendered: boolean;
  anchorResolved: boolean;
  attempts: number;
  maxOlderPages: number;
  hasOlderMessages: boolean;
  isLoadingOlderMessages: boolean;
  hasOlderMessagesError: boolean;
}): ResumeAttemptStep {
  if (anchorRendered) {
    return 'scroll';
  }
  if (anchorResolved) {
    return 'follow-tail';
  }
  // The in-flight check wins over both give-up checks below. The caller counts
  // an attempt when it *requests* a page, so at the bound the last allowed page
  // is still in flight: the bound check must not abandon it before its result
  // is inspected. Waiting also wins over the error check, because a retry (the
  // header's Retry CTA) starts a page load without clearing the last error, so
  // both are set for the whole retry. Either way the page may hold the anchor,
  // and giving up here would strand the open at the bottom even though the page
  // lands the anchor. The bound still ends the run on the next pass, once the
  // page has landed and resolved nothing.
  if (isLoadingOlderMessages) {
    return 'wait';
  }
  if (attempts >= maxOlderPages || !hasOlderMessages) {
    return 'follow-tail';
  }
  if (hasOlderMessagesError) {
    return 'follow-tail';
  }
  return 'load-older';
}

/**
 * Whether an accepted send may re-arm follow and take the position over. It may
 * only from the resume attempt that was live when it was sent: when the live
 * attempt is a different one, a `?at=` link arrived while the send was in
 * flight, its layout effect has already landed the anchor (and marked the
 * attempt done, so it will not pause again on a later render), and re-arming
 * follow would move the viewport to the bottom and abandon that anchor.
 *
 * The attempts are compared by identity; `null` means no resume was live.
 */
export function sendTakesOverResume<T extends object>(
  resumeAtSend: T | null,
  resumeNow: T | null
): boolean {
  return resumeNow === resumeAtSend;
}
